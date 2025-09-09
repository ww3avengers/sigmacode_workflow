import { NextResponse } from 'next/server'
import { authorizeCredentialUse } from '@/lib/auth/credential-access'
import { createLogger } from '@/lib/logs/console/logger'
import { generateRequestId } from '@/lib/utils'
import { refreshAccessTokenIfNeeded } from '@/app/api/auth/oauth/utils'

export const dynamic = 'force-dynamic'

const logger = createLogger('TeamsTeamsAPI')

export async function POST(request: Request) {
  try {
    const body = await request.json()

    const { credential, workflowId } = body

    if (!credential) {
      logger.error('Missing credential in request')
      return NextResponse.json({ error: 'Credential is required' }, { status: 400 })
    }

    try {
      const requestId = generateRequestId()
      const authz = await authorizeCredentialUse(request as any, {
        credentialId: credential,
        workflowId,
      })
      if (!authz.ok || !authz.credentialOwnerUserId) {
        return NextResponse.json({ error: authz.error || 'Unauthorized' }, { status: 403 })
      }

      const accessToken = await refreshAccessTokenIfNeeded(
        credential,
        authz.credentialOwnerUserId,
        'TeamsTeamsAPI'
      )

      if (!accessToken) {
        logger.error('Failed to get access token', {
          credentialId: credential,
          userId: authz.credentialOwnerUserId,
        })
        return NextResponse.json(
          {
            error: 'Could not retrieve access token',
            authRequired: true,
          },
          { status: 401 }
        )
      }

      const response = await fetch('https://graph.microsoft.com/v1.0/me/joinedTeams', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        const errorData = await response.json()
        logger.error('Microsoft Graph API error getting teams', {
          status: response.status,
          error: errorData,
          endpoint: 'https://graph.microsoft.com/v1.0/me/joinedTeams',
        })

        // Check for auth errors specifically
        if (response.status === 401) {
          return NextResponse.json(
            {
              error: 'Authentication failed. Please reconnect your Microsoft Teams account.',
              authRequired: true,
            },
            { status: 401 }
          )
        }

        throw new Error(`Microsoft Graph API error: ${JSON.stringify(errorData)}`)
      }

      const data = await response.json()
      const teams = data.value

      return NextResponse.json({
        teams: teams,
      })
    } catch (innerError) {
      logger.error('Error during API requests:', innerError)

      // Check if it's an authentication error
      const errorMessage = innerError instanceof Error ? innerError.message : String(innerError)
      if (
        errorMessage.includes('auth') ||
        errorMessage.includes('token') ||
        errorMessage.includes('unauthorized') ||
        errorMessage.includes('unauthenticated')
      ) {
        return NextResponse.json(
          {
            error: 'Authentication failed. Please reconnect your Microsoft Teams account.',
            authRequired: true,
            details: errorMessage,
          },
          { status: 401 }
        )
      }

      throw innerError
    }
  } catch (error) {
    logger.error('Error processing Teams request:', error)
    return NextResponse.json(
      {
        error: 'Failed to retrieve Microsoft Teams teams',
        details: (error as Error).message,
      },
      { status: 500 }
    )
  }
}
