/**
 * Integration tests for workflow deployment API route
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest } from '@/app/api/__test-utils__/utils'

describe('Workflow Deployment API Route', () => {
  beforeEach(() => {
    vi.resetModules()

    vi.doMock('@/lib/utils', () => ({
      generateApiKey: vi.fn().mockReturnValue('sim_testkeygenerated12345'),
      generateRequestId: vi.fn(() => 'test-request-id'),
    }))

    vi.doMock('uuid', () => ({
      v4: vi.fn().mockReturnValue('mock-uuid-1234'),
    }))

    vi.stubGlobal('crypto', {
      randomUUID: vi.fn().mockReturnValue('mock-request-id'),
    })

    vi.doMock('@/lib/logs/console/logger', () => ({
      createLogger: vi.fn().mockReturnValue({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }))

    // Mock serializer
    vi.doMock('@/serializer', () => ({
      serializeWorkflow: vi.fn().mockReturnValue({
        version: '1.0',
        blocks: [
          {
            id: 'block-1',
            metadata: { id: 'starter', name: 'Start' },
            position: { x: 100, y: 100 },
            config: { tool: 'starter', params: {} },
            inputs: {},
            outputs: {},
            enabled: true,
          },
        ],
        connections: [],
        loops: {},
        parallels: {},
      }),
    }))

    vi.doMock('@/lib/workflows/db-helpers', () => ({
      loadWorkflowFromNormalizedTables: vi.fn().mockResolvedValue({
        blocks: {
          'block-1': {
            id: 'block-1',
            type: 'starter',
            name: 'Start',
            position: { x: 100, y: 100 },
            enabled: true,
            subBlocks: {},
            outputs: {},
            data: {},
          },
        },
        edges: [],
        loops: {},
        parallels: {},
        isFromNormalizedTables: true,
      }),
    }))

    vi.doMock('@/app/api/workflows/middleware', () => ({
      validateWorkflowAccess: vi.fn().mockResolvedValue({
        workflow: {
          id: 'workflow-id',
          userId: 'user-id',
        },
      }),
    }))

    vi.doMock('@/app/api/workflows/utils', () => ({
      createSuccessResponse: vi.fn().mockImplementation((data) => {
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
      createErrorResponse: vi.fn().mockImplementation((message, status = 500) => {
        return new Response(JSON.stringify({ error: message }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    }))

    // Mock the database schema module
    vi.doMock('@/db/schema', () => ({
      workflow: {},
      apiKey: {},
      workflowBlocks: {},
      workflowEdges: {},
      workflowSubflows: {},
    }))

    // Mock drizzle-orm operators
    vi.doMock('drizzle-orm', () => ({
      eq: vi.fn((field, value) => ({ field, value, type: 'eq' })),
      and: vi.fn((...conditions) => ({ conditions, type: 'and' })),
    }))

    // Mock the database module with proper chainable query builder
    let selectCallCount = 0
    vi.doMock('@/db', () => ({
      db: {
        select: vi.fn().mockImplementation(() => {
          selectCallCount++
          const buildLimitResponse = () => ({
            limit: vi.fn().mockImplementation(() => {
              // First call: workflow lookup (should return workflow)
              if (selectCallCount === 1) {
                return Promise.resolve([{ userId: 'user-id', id: 'workflow-id' }])
              }
              // Second call: blocks lookup
              if (selectCallCount === 2) {
                return Promise.resolve([
                  {
                    id: 'block-1',
                    type: 'starter',
                    name: 'Start',
                    positionX: '100',
                    positionY: '100',
                    enabled: true,
                    subBlocks: {},
                    data: {},
                  },
                ])
              }
              // Third call: edges lookup
              if (selectCallCount === 3) {
                return Promise.resolve([])
              }
              // Fourth call: subflows lookup
              if (selectCallCount === 4) {
                return Promise.resolve([])
              }
              // Fifth call: API key lookup (should return empty for new key test)
              if (selectCallCount === 5) {
                return Promise.resolve([])
              }
              // Default: empty array
              return Promise.resolve([])
            }),
          })

          return {
            from: vi.fn().mockImplementation(() => ({
              where: vi.fn().mockImplementation(() => ({
                ...buildLimitResponse(),
                orderBy: vi.fn().mockReturnValue(buildLimitResponse()),
              })),
            })),
          }
        }),
        insert: vi.fn().mockImplementation(() => ({
          values: vi.fn().mockResolvedValue([{ id: 'mock-api-key-id' }]),
        })),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })),
      },
    }))
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  /**
   * Test GET deployment status
   */
  it('should fetch deployment info successfully', async () => {
    vi.doMock('@/db', () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  isDeployed: false,
                  deployedAt: null,
                  userId: 'user-id',
                  deployedState: null,
                },
              ]),
            }),
          }),
        }),
      },
    }))

    const req = createMockRequest('GET')

    const params = Promise.resolve({ id: 'workflow-id' })

    const { GET } = await import('@/app/api/workflows/[id]/deploy/route')

    const response = await GET(req, { params })

    expect(response.status).toBe(200)

    const data = await response.json()

    expect(data).toHaveProperty('isDeployed', false)
    expect(data).toHaveProperty('apiKey', null)
    expect(data).toHaveProperty('deployedAt', null)
  })

  // Removed two POST deployment tests by request

  /**
   * Test DELETE undeployment
   */
  it('should undeploy workflow successfully', async () => {
    const mockUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: 'workflow-id' }]),
      }),
    })

    vi.doMock('@/db', () => ({
      db: {
        update: mockUpdate,
      },
    }))

    const req = createMockRequest('DELETE')

    const params = Promise.resolve({ id: 'workflow-id' })

    const { DELETE } = await import('@/app/api/workflows/[id]/deploy/route')

    const response = await DELETE(req, { params })

    expect(response.status).toBe(200)

    const data = await response.json()

    expect(data).toHaveProperty('isDeployed', false)
    expect(data).toHaveProperty('deployedAt', null)
    expect(data).toHaveProperty('apiKey', null)

    expect(mockUpdate).toHaveBeenCalled()
  })

  /**
   * Test error handling
   */
  it('should handle errors when workflow is not found', async () => {
    vi.doMock('@/app/api/workflows/middleware', () => ({
      validateWorkflowAccess: vi.fn().mockResolvedValue({
        error: {
          message: 'Workflow not found',
          status: 404,
        },
      }),
    }))

    const req = createMockRequest('POST')

    const params = Promise.resolve({ id: 'invalid-id' })

    const { POST } = await import('@/app/api/workflows/[id]/deploy/route')

    const response = await POST(req, { params })

    expect(response.status).toBe(404)

    const data = await response.json()

    expect(data).toHaveProperty('error', 'Workflow not found')
  })

  /**
   * Test unauthorized access
   */
  it('should handle unauthorized access to workflow', async () => {
    vi.doMock('@/app/api/workflows/middleware', () => ({
      validateWorkflowAccess: vi.fn().mockResolvedValue({
        error: {
          message: 'Unauthorized access',
          status: 403,
        },
      }),
    }))

    const req = createMockRequest('POST')

    const params = Promise.resolve({ id: 'workflow-id' })

    const { POST } = await import('@/app/api/workflows/[id]/deploy/route')

    const response = await POST(req, { params })

    expect(response.status).toBe(403)

    const data = await response.json()

    expect(data).toHaveProperty('error', 'Unauthorized access')
  })
})
