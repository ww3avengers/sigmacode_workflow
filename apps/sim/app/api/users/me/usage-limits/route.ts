import { eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { checkHybridAuth } from '@/lib/auth/hybrid'
import { checkServerSideUsageLimits } from '@/lib/billing'
import { getHighestPrioritySubscription } from '@/lib/billing/core/subscription'
import { createLogger } from '@/lib/logs/console/logger'
import { createErrorResponse } from '@/app/api/workflows/utils'
import { db } from '@/db'
import { userStats } from '@/db/schema'
import { RateLimiter } from '@/services/queue'

const logger = createLogger('UsageLimitsAPI')

export async function GET(request: NextRequest) {
  try {
    const auth = await checkHybridAuth(request, { requireWorkflowId: false })
    if (!auth.success || !auth.userId) {
      return createErrorResponse('Authentication required', 401)
    }
    const authenticatedUserId = auth.userId

    // Rate limit info (sync + async), mirroring /users/me/rate-limit
    const userSubscription = await getHighestPrioritySubscription(authenticatedUserId)
    const rateLimiter = new RateLimiter()
    const triggerType = auth.authType === 'api_key' ? 'api' : 'manual'
    const [syncStatus, asyncStatus] = await Promise.all([
      rateLimiter.getRateLimitStatusWithSubscription(
        authenticatedUserId,
        userSubscription,
        triggerType,
        false
      ),
      rateLimiter.getRateLimitStatusWithSubscription(
        authenticatedUserId,
        userSubscription,
        triggerType,
        true
      ),
    ])

    // Usage summary (current period cost + limit + plan)
    const [usageCheck, statsRow] = await Promise.all([
      checkServerSideUsageLimits(authenticatedUserId),
      db
        .select({ currentPeriodCost: userStats.currentPeriodCost })
        .from(userStats)
        .where(eq(userStats.userId, authenticatedUserId))
        .limit(1),
    ])

    const currentPeriodCost = statsRow.length
      ? Number.parseFloat(statsRow[0].currentPeriodCost?.toString() || '0')
      : 0
    const usageLimitRemaining =
      usageCheck.limit > 0 ? Math.max(0, usageCheck.limit - currentPeriodCost) : 0

    return NextResponse.json({
      success: true,
      rateLimit: {
        sync: {
          isLimited: syncStatus.remaining === 0,
          limit: syncStatus.limit,
          remaining: syncStatus.remaining,
          resetAt: syncStatus.resetAt,
        },
        async: {
          isLimited: asyncStatus.remaining === 0,
          limit: asyncStatus.limit,
          remaining: asyncStatus.remaining,
          resetAt: asyncStatus.resetAt,
        },
        authType: triggerType,
      },
      usage: {
        currentPeriodCost,
        limit: usageCheck.limit,
        plan: userSubscription?.plan || 'free',
      },
    })
  } catch (error: any) {
    logger.error('Error checking usage limits:', error)
    return createErrorResponse(error.message || 'Failed to check usage limits', 500)
  }
}
