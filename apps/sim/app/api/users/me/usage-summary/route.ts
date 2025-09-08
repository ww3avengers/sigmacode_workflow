import { eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { checkHybridAuth } from '@/lib/auth/hybrid'
import { checkServerSideUsageLimits } from '@/lib/billing'
import { getHighestPrioritySubscription } from '@/lib/billing/core/subscription'
import { createLogger } from '@/lib/logs/console/logger'
import { db } from '@/db'
import { userStats } from '@/db/schema'

const logger = createLogger('UserUsageSummaryAPI')

export async function GET(request: NextRequest) {
  try {
    // Only accept API key auth for this external endpoint
    const auth = await checkHybridAuth(request, { requireWorkflowId: false })
    if (!auth.success || auth.authType !== 'api_key' || !auth.userId) {
      return NextResponse.json({ error: 'API key required' }, { status: 401 })
    }

    const userId = auth.userId

    const [statsRow] = await db
      .select({ currentPeriodCost: userStats.currentPeriodCost })
      .from(userStats)
      .where(eq(userStats.userId, userId))
      .limit(1)

    const usage = await checkServerSideUsageLimits(userId)
    const sub = await getHighestPrioritySubscription(userId)

    return NextResponse.json({
      success: true,
      data: {
        currentPeriodCost: statsRow
          ? Number.parseFloat(statsRow.currentPeriodCost?.toString() || '0')
          : 0,
        limit: usage.limit,
        plan: sub?.plan || 'free',
      },
    })
  } catch (error) {
    logger.error('Failed to get usage summary', { error })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
