import { type NextRequest, NextResponse } from 'next/server'
import { getHighestPrioritySubscription } from '@/lib/billing/core/subscription'
import { createLogger } from '@/lib/logs/console/logger'
import { RateLimiter } from '@/services/queue/RateLimiter'
import { authenticateApiKey } from './auth'

const logger = createLogger('V1Middleware')
const rateLimiter = new RateLimiter()

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: Date
  userId?: string
  error?: string
}

export async function checkRateLimit(
  request: NextRequest,
  endpoint: 'logs' | 'logs-detail' = 'logs'
): Promise<RateLimitResult> {
  try {
    const auth = await authenticateApiKey(request)
    if (!auth.authenticated) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: new Date(),
        error: auth.error,
      }
    }

    const userId = auth.userId!
    const subscription = await getHighestPrioritySubscription(userId)

    const isAsync = endpoint === 'logs'
    const result = await rateLimiter.checkRateLimitWithSubscription(
      userId,
      subscription,
      'api',
      isAsync
    )

    if (!result.allowed) {
      logger.warn(`Rate limit exceeded for user ${userId}`, {
        endpoint,
        remaining: result.remaining,
        resetAt: result.resetAt,
      })
    }

    return {
      ...result,
      userId,
    }
  } catch (error) {
    logger.error('Rate limit check error', { error })
    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60000),
      error: 'Rate limit check failed',
    }
  }
}

export function createRateLimitResponse(result: RateLimitResult): NextResponse {
  const headers = {
    'X-RateLimit-Limit': '60',
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': result.resetAt.toISOString(),
  }

  if (!result.allowed) {
    return NextResponse.json(
      {
        error: 'Rate limit exceeded',
        message: `API rate limit exceeded. Please retry after ${result.resetAt.toISOString()}`,
        retryAfter: result.resetAt.getTime(),
      },
      {
        status: 429,
        headers: {
          ...headers,
          'Retry-After': Math.ceil((result.resetAt.getTime() - Date.now()) / 1000).toString(),
        },
      }
    )
  }

  return NextResponse.json({ error: result.error || 'Unauthorized' }, { status: 401, headers })
}
