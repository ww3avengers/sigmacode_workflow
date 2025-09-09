import { eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { createLogger } from '@/lib/logs/console/logger'
import { generateRequestId } from '@/lib/utils'
import { db } from '@/db'
import { workflow, workflowBlocks, workspace } from '@/db/schema'
import { verifyWorkspaceMembership } from './utils'

const logger = createLogger('WorkflowAPI')

const CreateWorkflowSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional().default(''),
  color: z.string().optional().default('#3972F6'),
  workspaceId: z.string().optional(),
  folderId: z.string().nullable().optional(),
})

// GET /api/workflows - Get workflows for user (optionally filtered by workspaceId)
export async function GET(request: Request) {
  const requestId = generateRequestId()
  const startTime = Date.now()
  const url = new URL(request.url)
  const workspaceId = url.searchParams.get('workspaceId')

  try {
    const session = await getSession()
    if (!session?.user?.id) {
      logger.warn(`[${requestId}] Unauthorized workflow access attempt`)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userId = session.user.id

    if (workspaceId) {
      const workspaceExists = await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(eq(workspace.id, workspaceId))
        .then((rows) => rows.length > 0)

      if (!workspaceExists) {
        logger.warn(
          `[${requestId}] Attempt to fetch workflows for non-existent workspace: ${workspaceId}`
        )
        return NextResponse.json(
          { error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' },
          { status: 404 }
        )
      }

      const userRole = await verifyWorkspaceMembership(userId, workspaceId)

      if (!userRole) {
        logger.warn(
          `[${requestId}] User ${userId} attempted to access workspace ${workspaceId} without membership`
        )
        return NextResponse.json(
          { error: 'Access denied to this workspace', code: 'WORKSPACE_ACCESS_DENIED' },
          { status: 403 }
        )
      }
    }

    let workflows

    if (workspaceId) {
      workflows = await db.select().from(workflow).where(eq(workflow.workspaceId, workspaceId))
    } else {
      workflows = await db.select().from(workflow).where(eq(workflow.userId, userId))
    }

    return NextResponse.json({ data: workflows }, { status: 200 })
  } catch (error: any) {
    const elapsed = Date.now() - startTime
    logger.error(`[${requestId}] Workflow fetch error after ${elapsed}ms`, error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// POST /api/workflows - Create a new workflow
export async function POST(req: NextRequest) {
  const requestId = generateRequestId()
  const session = await getSession()

  if (!session?.user?.id) {
    logger.warn(`[${requestId}] Unauthorized workflow creation attempt`)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { name, description, color, workspaceId, folderId } = CreateWorkflowSchema.parse(body)

    const workflowId = crypto.randomUUID()
    const starterId = crypto.randomUUID()
    const now = new Date()

    logger.info(`[${requestId}] Creating workflow ${workflowId} for user ${session.user.id}`)

    await db.transaction(async (tx) => {
      await tx.insert(workflow).values({
        id: workflowId,
        userId: session.user.id,
        workspaceId: workspaceId || null,
        folderId: folderId || null,
        name,
        description,
        color,
        lastSynced: now,
        createdAt: now,
        updatedAt: now,
        isDeployed: false,
        collaborators: [],
        runCount: 0,
        variables: {},
        isPublished: false,
        marketplaceData: null,
      })

      await tx.insert(workflowBlocks).values({
        id: starterId,
        workflowId: workflowId,
        type: 'starter',
        name: 'Start',
        positionX: '100',
        positionY: '100',
        enabled: true,
        horizontalHandles: true,
        isWide: false,
        advancedMode: false,
        triggerMode: false,
        height: '95',
        subBlocks: {
          startWorkflow: {
            id: 'startWorkflow',
            type: 'dropdown',
            value: 'manual',
          },
          webhookPath: {
            id: 'webhookPath',
            type: 'short-input',
            value: '',
          },
          webhookSecret: {
            id: 'webhookSecret',
            type: 'short-input',
            value: '',
          },
          scheduleType: {
            id: 'scheduleType',
            type: 'dropdown',
            value: 'daily',
          },
          minutesInterval: {
            id: 'minutesInterval',
            type: 'short-input',
            value: '',
          },
          minutesStartingAt: {
            id: 'minutesStartingAt',
            type: 'short-input',
            value: '',
          },
          hourlyMinute: {
            id: 'hourlyMinute',
            type: 'short-input',
            value: '',
          },
          dailyTime: {
            id: 'dailyTime',
            type: 'short-input',
            value: '',
          },
          weeklyDay: {
            id: 'weeklyDay',
            type: 'dropdown',
            value: 'MON',
          },
          weeklyDayTime: {
            id: 'weeklyDayTime',
            type: 'short-input',
            value: '',
          },
          monthlyDay: {
            id: 'monthlyDay',
            type: 'short-input',
            value: '',
          },
          monthlyTime: {
            id: 'monthlyTime',
            type: 'short-input',
            value: '',
          },
          cronExpression: {
            id: 'cronExpression',
            type: 'short-input',
            value: '',
          },
          timezone: {
            id: 'timezone',
            type: 'dropdown',
            value: 'UTC',
          },
        },
        outputs: {
          response: {
            type: {
              input: 'any',
            },
          },
        },
        createdAt: now,
        updatedAt: now,
      })

      logger.info(
        `[${requestId}] Successfully created workflow ${workflowId} with start block in workflow_blocks table`
      )
    })

    return NextResponse.json({
      id: workflowId,
      name,
      description,
      color,
      workspaceId,
      folderId,
      createdAt: now,
      updatedAt: now,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn(`[${requestId}] Invalid workflow creation data`, {
        errors: error.errors,
      })
      return NextResponse.json(
        { error: 'Invalid request data', details: error.errors },
        { status: 400 }
      )
    }

    logger.error(`[${requestId}] Error creating workflow`, error)
    return NextResponse.json({ error: 'Failed to create workflow' }, { status: 500 })
  }
}
