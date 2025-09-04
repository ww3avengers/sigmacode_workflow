#!/usr/bin/env bun

import { eq, sql } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { db } from '../db'
import {
  workflow,
  workflowBlocks,
  workflowDeploymentVersion,
  workflowEdges,
  workflowSubflows,
} from '../db/schema'

const DRY_RUN = process.argv.includes('--dry-run')
const BATCH_SIZE = 50

interface WorkflowState {
  blocks: Record<string, any>
  edges: Array<{ id: string; source: string; target: string; [key: string]: any }>
  loops?: Record<string, any>
  parallels?: Record<string, any>
}

async function loadWorkflowFromNormalizedTables(workflowId: string): Promise<WorkflowState | null> {
  try {
    const [blocks, edges, subflows] = await Promise.all([
      db.select().from(workflowBlocks).where(eq(workflowBlocks.workflowId, workflowId)),
      db.select().from(workflowEdges).where(eq(workflowEdges.workflowId, workflowId)),
      db.select().from(workflowSubflows).where(eq(workflowSubflows.workflowId, workflowId)),
    ])

    const blocksMap: Record<string, any> = {}
    const loops: Record<string, any> = {}
    const parallels: Record<string, any> = {}

    for (const block of blocks) {
      blocksMap[block.id] = {
        id: block.id,
        type: block.type,
        position: {
          x: Number.parseFloat(block.positionX),
          y: Number.parseFloat(block.positionY),
        },
        data: block.data || {},
        subflows: [],
      }
    }

    for (const subflow of subflows) {
      // Subflows are stored differently - they represent loops and parallels
      // We need to associate them with their parent blocks
      if (subflow.type === 'loop' && subflow.config) {
        loops[subflow.id] = subflow.config
      } else if (subflow.type === 'parallel' && subflow.config) {
        parallels[subflow.id] = subflow.config
      }
    }

    const edgesArray = edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceBlockId,
      target: edge.targetBlockId,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
    }))

    return {
      blocks: blocksMap,
      edges: edgesArray,
      loops,
      parallels,
    }
  } catch (error) {
    console.error(`Failed to load workflow ${workflowId} from normalized tables:`, error)
    return null
  }
}

async function migrateWorkflows() {
  console.log('Starting deployment version migration...')
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
  console.log(`Batch size: ${BATCH_SIZE}`)
  console.log('---')

  try {
    // Get all workflows
    const workflows = await db
      .select({
        id: workflow.id,
        name: workflow.name,
        isDeployed: workflow.isDeployed,
        deployedState: workflow.deployedState,
        deployedAt: workflow.deployedAt,
        userId: workflow.userId,
      })
      .from(workflow)

    console.log(`Found ${workflows.length} workflows to process`)

    // Check for existing deployment versions
    const existingVersions = await db
      .select({
        workflowId: workflowDeploymentVersion.workflowId,
      })
      .from(workflowDeploymentVersion)

    const existingWorkflowIds = new Set(existingVersions.map((v) => v.workflowId))
    console.log(`${existingWorkflowIds.size} workflows already have deployment versions`)

    let successCount = 0
    let skipCount = 0
    let errorCount = 0
    const errors: Array<{ workflowId: string; error: string }> = []

    // Process in batches
    for (let i = 0; i < workflows.length; i += BATCH_SIZE) {
      const batch = workflows.slice(i, i + BATCH_SIZE)
      console.log(
        `\nProcessing batch ${Math.floor(i / BATCH_SIZE) + 1} (workflows ${i + 1}-${Math.min(i + BATCH_SIZE, workflows.length)})`
      )

      const deploymentVersions = []

      for (const wf of batch) {
        // Skip if already has deployment version
        if (existingWorkflowIds.has(wf.id)) {
          console.log(`  [SKIP] ${wf.id} (${wf.name}) - already has deployment version`)
          skipCount++
          continue
        }

        let state: WorkflowState | null = null

        // First try to use existing deployedState
        if (wf.deployedState) {
          state = wf.deployedState as WorkflowState
          console.log(`  [DEPLOYED] ${wf.id} (${wf.name}) - using existing deployedState`)
        } else {
          // Load from normalized tables for all workflows without deployedState
          state = await loadWorkflowFromNormalizedTables(wf.id)
          if (state) {
            console.log(
              `  [NORMALIZED] ${wf.id} (${wf.name}) - loaded from normalized tables (was deployed: ${wf.isDeployed})`
            )
          } else {
            console.log(`  [SKIP] ${wf.id} (${wf.name}) - no state available`)
            skipCount++
            continue
          }
        }

        if (state) {
          deploymentVersions.push({
            id: uuidv4(),
            workflowId: wf.id,
            version: 1,
            state: state,
            createdAt: wf.deployedAt || new Date(),
            createdBy: wf.userId || 'migration',
            isActive: true, // Set ALL to active so schedules/webhooks keep working
          })
          successCount++
        }
      }

      // Insert batch if not dry run
      if (deploymentVersions.length > 0) {
        if (DRY_RUN) {
          console.log(`  [DRY RUN] Would insert ${deploymentVersions.length} deployment versions`)
          console.log(`  [DRY RUN] Would mark ${deploymentVersions.length} workflows as deployed`)
        } else {
          try {
            // Insert deployment versions
            await db.insert(workflowDeploymentVersion).values(deploymentVersions)
            console.log(`  [SUCCESS] Inserted ${deploymentVersions.length} deployment versions`)

            // Update workflow.isDeployed to true for all workflows that got a version
            const workflowIds = deploymentVersions.map((v) => v.workflowId)
            await db
              .update(workflow)
              .set({
                isDeployed: true,
                deployedAt: new Date(), // Set deployedAt if it wasn't already set
              })
              .where(
                sql`${workflow.id} IN (${sql.join(
                  workflowIds.map((id) => sql`${id}`),
                  sql`, `
                )})`
              )
            console.log(`  [SUCCESS] Marked ${workflowIds.length} workflows as deployed`)
          } catch (error) {
            console.error(`  [ERROR] Failed to insert batch:`, error)
            errorCount += deploymentVersions.length
            successCount -= deploymentVersions.length
          }
        }
      }
    }

    console.log('\n---')
    console.log('Migration Summary:')
    console.log(`  Success: ${successCount} workflows`)
    console.log(`  Skipped: ${skipCount} workflows`)
    console.log(`  Errors: ${errorCount} workflows`)

    if (errors.length > 0) {
      console.log('\nErrors:')
      errors.forEach(({ workflowId, error }) => {
        console.log(`  - ${workflowId}: ${error}`)
      })
    }

    if (DRY_RUN) {
      console.log('\n[DRY RUN] No changes were made to the database.')
      console.log('Run without --dry-run flag to apply changes.')
    } else {
      console.log('\nMigration completed successfully!')
    }
  } catch (error) {
    console.error('Fatal error during migration:', error)
    process.exit(1)
  }
}

// Run the migration
migrateWorkflows()
  .then(() => {
    console.log('\nDone!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Unexpected error:', error)
    process.exit(1)
  })
