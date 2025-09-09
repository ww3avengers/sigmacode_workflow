import { and, eq } from 'drizzle-orm'
import { jwtDecode } from 'jwt-decode'
import { type NextRequest, NextResponse } from 'next/server'
import { checkHybridAuth } from '@/lib/auth/hybrid'
import { createLogger } from '@/lib/logs/console/logger'
import type { OAuthService } from '@/lib/oauth/oauth'
import { parseProvider } from '@/lib/oauth/oauth'
import { getUserEntityPermissions } from '@/lib/permissions/utils'
import { generateRequestId } from '@/lib/utils'
import { db } from '@/db'
import { account, user, workflow } from '@/db/schema'

export const dynamic = 'force-dynamic'

const logger = createLogger('OAuthCredentialsAPI')

interface GoogleIdToken {
  email?: string
  sub?: string
  name?: string
}

/**
 * Get credentials for a specific provider
 */
export async function GET(request: NextRequest) {
  const requestId = generateRequestId()

  try {
    // Get query params
    const { searchParams } = new URL(request.url)
    const providerParam = searchParams.get('provider') as OAuthService | null
    const workflowId = searchParams.get('workflowId')
    const credentialId = searchParams.get('credentialId')

    // Authenticate requester (supports session, API key, internal JWT)
    const authResult = await checkHybridAuth(request)
    if (!authResult.success || !authResult.userId) {
      logger.warn(`[${requestId}] Unauthenticated credentials request rejected`)
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 })
    }
    const requesterUserId = authResult.userId

    // Resolve effective user id: workflow owner if workflowId provided (with access check); else requester
    let effectiveUserId: string
    if (workflowId) {
      // Load workflow owner and workspace for access control
      const rows = await db
        .select({ userId: workflow.userId, workspaceId: workflow.workspaceId })
        .from(workflow)
        .where(eq(workflow.id, workflowId))
        .limit(1)

      if (!rows.length) {
        logger.warn(`[${requestId}] Workflow not found for credentials request`, { workflowId })
        return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
      }

      const wf = rows[0]

      if (requesterUserId !== wf.userId) {
        if (!wf.workspaceId) {
          logger.warn(
            `[${requestId}] Forbidden - workflow has no workspace and requester is not owner`,
            {
              requesterUserId,
            }
          )
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const perm = await getUserEntityPermissions(requesterUserId, 'workspace', wf.workspaceId)
        if (perm === null) {
          logger.warn(`[${requestId}] Forbidden credentials request - no workspace access`, {
            requesterUserId,
            workspaceId: wf.workspaceId,
          })
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
      }

      effectiveUserId = wf.userId
    } else {
      effectiveUserId = requesterUserId
    }

    if (!providerParam && !credentialId) {
      logger.warn(`[${requestId}] Missing provider parameter`)
      return NextResponse.json({ error: 'Provider or credentialId is required' }, { status: 400 })
    }

    // Parse the provider to get base provider and feature type (if provider is present)
    const { baseProvider } = parseProvider(providerParam || 'google-default')

    let accountsData

    if (credentialId) {
      // Foreign-aware lookup for a specific credential by id
      // If workflowId is provided and requester has access (checked above), allow fetching by id only
      if (workflowId) {
        accountsData = await db.select().from(account).where(eq(account.id, credentialId))
      } else {
        // Fallback: constrain to requester's own credentials when not in a workflow context
        accountsData = await db
          .select()
          .from(account)
          .where(and(eq(account.userId, effectiveUserId), eq(account.id, credentialId)))
      }
    } else {
      // Fetch all credentials for provider and effective user
      accountsData = await db
        .select()
        .from(account)
        .where(and(eq(account.userId, effectiveUserId), eq(account.providerId, providerParam!)))
    }

    // Transform accounts into credentials
    const credentials = await Promise.all(
      accountsData.map(async (acc) => {
        // Extract the feature type from providerId (e.g., 'google-default' -> 'default')
        const [_, featureType = 'default'] = acc.providerId.split('-')

        // Try multiple methods to get a user-friendly display name
        let displayName = ''

        // Method 1: Try to extract email from ID token (works for Google, etc.)
        if (acc.idToken) {
          try {
            const decoded = jwtDecode<GoogleIdToken>(acc.idToken)
            if (decoded.email) {
              displayName = decoded.email
            } else if (decoded.name) {
              displayName = decoded.name
            }
          } catch (_error) {
            logger.warn(`[${requestId}] Error decoding ID token`, {
              accountId: acc.id,
            })
          }
        }

        // Method 2: For GitHub, the accountId might be the username
        if (!displayName && baseProvider === 'github') {
          displayName = `${acc.accountId} (GitHub)`
        }

        // Method 3: Try to get the user's email from our database
        if (!displayName) {
          try {
            const userRecord = await db
              .select({ email: user.email })
              .from(user)
              .where(eq(user.id, acc.userId))
              .limit(1)

            if (userRecord.length > 0) {
              displayName = userRecord[0].email
            }
          } catch (_error) {
            logger.warn(`[${requestId}] Error fetching user email`, {
              userId: acc.userId,
            })
          }
        }

        // Fallback: Use accountId with provider type as context
        if (!displayName) {
          displayName = `${acc.accountId} (${baseProvider})`
        }

        return {
          id: acc.id,
          name: displayName,
          provider: acc.providerId,
          lastUsed: acc.updatedAt.toISOString(),
          isDefault: featureType === 'default',
        }
      })
    )

    return NextResponse.json({ credentials }, { status: 200 })
  } catch (error) {
    logger.error(`[${requestId}] Error fetching OAuth credentials`, error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
