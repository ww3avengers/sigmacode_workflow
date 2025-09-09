import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { env } from '@/lib/env'
import { createLogger } from '@/lib/logs/console/logger'
import { SIM_AGENT_API_URL_DEFAULT } from '@/lib/sim-agent'
import { generateRequestId } from '@/lib/utils'
import { getAllBlocks } from '@/blocks/registry'
import type { BlockConfig } from '@/blocks/types'
import { resolveOutputType } from '@/blocks/utils'
import { generateLoopBlocks, generateParallelBlocks } from '@/stores/workflows/workflow/utils'

const logger = createLogger('YamlToWorkflowAPI')

// Sim Agent API configuration
const SIM_AGENT_API_URL = env.SIM_AGENT_API_URL || SIM_AGENT_API_URL_DEFAULT

const ConvertRequestSchema = z.object({
  yamlContent: z.string().min(1),
  options: z
    .object({
      generateNewIds: z.boolean().optional(),
      preservePositions: z.boolean().optional(),
      existingBlocks: z.record(z.any()).optional(),
    })
    .optional(),
})

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()

  try {
    const body = await request.json()
    const { yamlContent, options } = ConvertRequestSchema.parse(body)

    logger.info(`[${requestId}] Converting YAML to workflow`, {
      contentLength: yamlContent.length,
      hasOptions: !!options,
    })

    // Gather block registry and utilities
    const blocks = getAllBlocks()
    const blockRegistry = blocks.reduce(
      (acc, block) => {
        const blockType = block.type
        acc[blockType] = {
          ...block,
          id: blockType,
          subBlocks: block.subBlocks || [],
          outputs: block.outputs || {},
        } as any
        return acc
      },
      {} as Record<string, BlockConfig>
    )

    // Call sim-agent API
    const response = await fetch(`${SIM_AGENT_API_URL}/api/yaml/to-workflow`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        yamlContent,
        blockRegistry,
        utilities: {
          generateLoopBlocks: generateLoopBlocks.toString(),
          generateParallelBlocks: generateParallelBlocks.toString(),
          resolveOutputType: resolveOutputType.toString(),
        },
        options,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      logger.error(`[${requestId}] Sim agent API error:`, {
        status: response.status,
        error: errorText,
      })
      return NextResponse.json(
        { success: false, errors: [`Sim agent API error: ${response.statusText}`], warnings: [] },
        { status: response.status }
      )
    }

    const result = await response.json()
    return NextResponse.json(result)
  } catch (error) {
    logger.error(`[${requestId}] YAML to workflow conversion failed:`, error)

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, errors: error.errors.map((e) => e.message), warnings: [] },
        { status: 400 }
      )
    }

    return NextResponse.json(
      {
        success: false,
        errors: [error instanceof Error ? error.message : 'Unknown error'],
        warnings: [],
      },
      { status: 500 }
    )
  }
}
