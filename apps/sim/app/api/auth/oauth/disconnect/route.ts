import { and, eq, like, or } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { createLogger } from '@/lib/logs/console/logger'
import { generateRequestId } from '@/lib/utils'
import { db } from '@/db'
import { account } from '@/db/schema'

export const dynamic = 'force-dynamic'

const logger = createLogger('OAuthDisconnectAPI')

/**
 * Disconnect an OAuth provider for the current user
 */
export async function POST(request: NextRequest) {
  const requestId = generateRequestId()

  try {
    // Get the session
    const session = await getSession()

    // Check if the user is authenticated
    if (!session?.user?.id) {
      logger.warn(`[${requestId}] Unauthenticated disconnect request rejected`)
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 })
    }

    // Get the provider and providerId from the request body
    const { provider, providerId } = await request.json()

    if (!provider) {
      logger.warn(`[${requestId}] Missing provider in disconnect request`)
      return NextResponse.json({ error: 'Provider is required' }, { status: 400 })
    }

    logger.info(`[${requestId}] Processing OAuth disconnect request`, {
      provider,
      hasProviderId: !!providerId,
    })

    // If a specific providerId is provided, delete only that account
    if (providerId) {
      await db
        .delete(account)
        .where(and(eq(account.userId, session.user.id), eq(account.providerId, providerId)))
    } else {
      // Otherwise, delete all accounts for this provider
      // Handle both exact matches (e.g., 'confluence') and prefixed matches (e.g., 'google-email')
      await db
        .delete(account)
        .where(
          and(
            eq(account.userId, session.user.id),
            or(eq(account.providerId, provider), like(account.providerId, `${provider}-%`))
          )
        )
    }

    return NextResponse.json({ success: true }, { status: 200 })
  } catch (error) {
    logger.error(`[${requestId}] Error disconnecting OAuth provider`, error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
