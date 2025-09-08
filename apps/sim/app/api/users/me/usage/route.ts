import { eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { checkHybridAuth } from '@/lib/auth/hybrid'
import { checkServerSideUsageLimits } from '@/lib/billing'
import { getHighestPrioritySubscription } from '@/lib/billing/core/subscription'
import { createLogger } from '@/lib/logs/console/logger'
import { createErrorResponse } from '@/app/api/workflows/utils'
import { db } from '@/db'
import { userStats } from '@/db/schema'

const logger = createLogger('UserUsageAPI')

export async function GET(request: NextRequest) {
  try {
    const auth = await checkHybridAuth(request, { requireWorkflowId: false })
    const authenticatedUserId = auth?.userId || null

    if (!authenticatedUserId) {
      return createErrorResponse('Authentication required', 401)
    }

    const usage = await checkServerSideUsageLimits(authenticatedUserId)

    // Plan context (free/pro/team/enterprise)
    const sub = await getHighestPrioritySubscription(authenticatedUserId)

    // Current period usage (source of truth in user_stats)
    const statsRows = await db
      .select({
        currentPeriodCost: userStats.currentPeriodCost,
      })
      .from(userStats)
      .where(eq(userStats.userId, authenticatedUserId))
      .limit(1)

    const currentPeriodCost = statsRows.length
      ? Number.parseFloat(statsRows[0].currentPeriodCost?.toString() || '0')
      : 0

    return NextResponse.json({
      success: true,
      data: {
        currentPeriodCost,
        limit: usage.limit,
        plan: sub?.plan || 'free',
      },
    })
  } catch (error: any) {
    logger.error('Error checking usage:', error)
    return createErrorResponse(error.message || 'Failed to check usage', 500)
  }
}
