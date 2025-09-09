import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolConfig } from '@/tools/types'
import {
  createCustomToolRequestBody,
  createParamSchema,
  executeRequest,
  formatRequestParams,
  getClientEnvVars,
  transformTable,
  validateRequiredParametersAfterMerge,
} from '@/tools/utils'

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('@/stores/settings/environment/store', () => {
  const mockStore = {
    getAllVariables: vi.fn().mockReturnValue({
      API_KEY: { value: 'mock-api-key' },
      BASE_URL: { value: 'https://example.com' },
    }),
  }

  return {
    useEnvironmentStore: {
      getState: vi.fn().mockImplementation(() => mockStore),
    },
  }
})

const originalWindow = global.window
beforeEach(() => {
  global.window = {} as any
})

afterEach(() => {
  global.window = originalWindow

  vi.clearAllMocks()
})

describe('transformTable', () => {
  it.concurrent('should return empty object for null input', () => {
    const result = transformTable(null)
    expect(result).toEqual({})
  })

  it.concurrent('should transform table rows to key-value pairs', () => {
    const table = [
      { id: '1', cells: { Key: 'name', Value: 'John Doe' } },
      { id: '2', cells: { Key: 'age', Value: 30 } },
      { id: '3', cells: { Key: 'isActive', Value: true } },
      { id: '4', cells: { Key: 'data', Value: { foo: 'bar' } } },
    ]

    const result = transformTable(table)

    expect(result).toEqual({
      name: 'John Doe',
      age: 30,
      isActive: true,
      data: { foo: 'bar' },
    })
  })

  it.concurrent('should skip rows without Key or Value properties', () => {
    const table: any = [
      { id: '1', cells: { Key: 'name', Value: 'John Doe' } },
      { id: '2', cells: { Key: 'age' } }, // Missing Value
      { id: '3', cells: { Value: true } }, // Missing Key
      { id: '4', cells: {} }, // Empty cells
    ]

    const result = transformTable(table)

    expect(result).toEqual({
      name: 'John Doe',
    })
  })

  it.concurrent('should handle Value=0 and Value=false correctly', () => {
    const table = [
      { id: '1', cells: { Key: 'count', Value: 0 } },
      { id: '2', cells: { Key: 'enabled', Value: false } },
    ]

    const result = transformTable(table)

    expect(result).toEqual({
      count: 0,
      enabled: false,
    })
  })
})

describe('formatRequestParams', () => {
  let mockTool: ToolConfig

  beforeEach(() => {
    mockTool = {
      id: 'test-tool',
      name: 'Test Tool',
      description: 'A test tool',
      version: '1.0.0',
      params: {},
      request: {
        url: 'https://api.example.com',
        method: 'GET',
        headers: vi.fn().mockReturnValue({
          'Content-Type': 'application/json',
        }),
        body: vi.fn().mockReturnValue({ data: 'test-data' }),
      },
    }
  })

  it.concurrent('should format request with static URL', () => {
    const params = { foo: 'bar' }
    const result = formatRequestParams(mockTool, params)

    expect(result).toEqual({
      url: 'https://api.example.com',
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: undefined, // No body for GET
    })

    expect(mockTool.request.headers).toHaveBeenCalledWith(params)
  })

  it.concurrent('should format request with dynamic URL function', () => {
    mockTool.request.url = (params) => `https://api.example.com/${params.id}`
    const params = { id: '123' }

    const result = formatRequestParams(mockTool, params)

    expect(result).toEqual({
      url: 'https://api.example.com/123',
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    })
  })

  it.concurrent('should use method from params over tool default', () => {
    const params = { method: 'POST' }
    const result = formatRequestParams(mockTool, params)

    expect(result.method).toBe('POST')
    expect(result.body).toBe(JSON.stringify({ data: 'test-data' }))
    expect(mockTool.request.body).toHaveBeenCalledWith(params)
  })

  it.concurrent('should handle preformatted content types', () => {
    // Set Content-Type to a preformatted type
    mockTool.request.headers = vi.fn().mockReturnValue({
      'Content-Type': 'application/x-www-form-urlencoded',
    })

    // Return a preformatted body
    mockTool.request.body = vi.fn().mockReturnValue('key1=value1&key2=value2')

    const params = { method: 'POST' }
    const result = formatRequestParams(mockTool, params)

    expect(result.body).toBe('key1=value1&key2=value2')
  })

  it.concurrent('should handle NDJSON content type', () => {
    // Set Content-Type to NDJSON
    mockTool.request.headers = vi.fn().mockReturnValue({
      'Content-Type': 'application/x-ndjson',
    })

    // Return a preformatted body for NDJSON
    mockTool.request.body = vi.fn().mockReturnValue('{"prompt": "Hello"}\n{"prompt": "World"}')

    const params = { method: 'POST' }
    const result = formatRequestParams(mockTool, params)

    expect(result.body).toBe('{"prompt": "Hello"}\n{"prompt": "World"}')
  })
})

describe('validateRequiredParametersAfterMerge', () => {
  let mockTool: ToolConfig

  beforeEach(() => {
    mockTool = {
      id: 'test-tool',
      name: 'Test Tool',
      description: 'A test tool',
      version: '1.0.0',
      params: {
        required1: {
          type: 'string',
          required: true,
          visibility: 'user-or-llm',
        },
        required2: {
          type: 'number',
          required: true,
          visibility: 'user-or-llm',
        },
        optional: {
          type: 'boolean',
        },
      },
      request: {
        url: 'https://api.example.com',
        method: 'GET',
        headers: () => ({}),
      },
    }
  })

  it.concurrent('should throw error for missing tool', () => {
    expect(() => {
      validateRequiredParametersAfterMerge('missing-tool', undefined, {})
    }).toThrow('Tool not found: missing-tool')
  })

  it.concurrent('should throw error for missing required parameters', () => {
    expect(() => {
      validateRequiredParametersAfterMerge('test-tool', mockTool, {
        required1: 'value',
        // required2 is missing
      })
    }).toThrow('"Required2" is required for Test Tool')
  })

  it.concurrent('should not throw error when all required parameters are provided', () => {
    expect(() => {
      validateRequiredParametersAfterMerge('test-tool', mockTool, {
        required1: 'value',
        required2: 42,
      })
    }).not.toThrow()
  })

  it.concurrent('should not require optional parameters', () => {
    expect(() => {
      validateRequiredParametersAfterMerge('test-tool', mockTool, {
        required1: 'value',
        required2: 42,
        // optional parameter not provided
      })
    }).not.toThrow()
  })

  it.concurrent('should handle null and empty string values as missing', () => {
    expect(() => {
      validateRequiredParametersAfterMerge('test-tool', mockTool, {
        required1: null,
        required2: '',
      })
    }).toThrow('"Required1" is required for Test Tool')
  })

  it.concurrent(
    'should not validate user-only parameters (they should be validated earlier)',
    () => {
      const toolWithUserOnlyParam = {
        ...mockTool,
        params: {
          ...mockTool.params,
          apiKey: {
            type: 'string' as const,
            required: true,
            visibility: 'user-only' as const, // This should NOT be validated here
          },
        },
      }

      // Should NOT throw for missing user-only params - they're validated at serialization
      expect(() => {
        validateRequiredParametersAfterMerge('test-tool', toolWithUserOnlyParam, {
          required1: 'value',
          required2: 42,
          // apiKey missing but it's user-only, so not validated here
        })
      }).not.toThrow()
    }
  )

  it.concurrent('should validate mixed user-or-llm and user-only parameters correctly', () => {
    const toolWithMixedParams = {
      ...mockTool,
      params: {
        userOrLlmParam: {
          type: 'string' as const,
          required: true,
          visibility: 'user-or-llm' as const, // Should be validated
        },
        userOnlyParam: {
          type: 'string' as const,
          required: true,
          visibility: 'user-only' as const, // Should NOT be validated
        },
        optionalParam: {
          type: 'string' as const,
          required: false,
          visibility: 'user-or-llm' as const,
        },
      },
    }

    // Should throw for missing user-or-llm param, but not user-only param
    expect(() => {
      validateRequiredParametersAfterMerge('test-tool', toolWithMixedParams, {
        // userOrLlmParam missing - should cause error
        // userOnlyParam missing - should NOT cause error (validated earlier)
      })
    }).toThrow('"User Or Llm Param" is required for')
  })

  it.concurrent('should use parameter description in error messages when available', () => {
    const toolWithDescriptions = {
      ...mockTool,
      params: {
        subreddit: {
          type: 'string' as const,
          required: true,
          visibility: 'user-or-llm' as const,
          description: 'Subreddit name (without r/ prefix)',
        },
      },
    }

    expect(() => {
      validateRequiredParametersAfterMerge('test-tool', toolWithDescriptions, {})
    }).toThrow('"Subreddit" is required for Test Tool')
  })

  it.concurrent('should fall back to parameter name when no description available', () => {
    const toolWithoutDescription = {
      ...mockTool,
      params: {
        subreddit: {
          type: 'string' as const,
          required: true,
          visibility: 'user-or-llm' as const,
          // No description provided
        },
      },
    }

    expect(() => {
      validateRequiredParametersAfterMerge('test-tool', toolWithoutDescription, {})
    }).toThrow('"Subreddit" is required for Test Tool')
  })

  it.concurrent('should handle undefined values as missing', () => {
    expect(() => {
      validateRequiredParametersAfterMerge('test-tool', mockTool, {
        required1: 'value',
        required2: undefined, // Explicitly undefined
      })
    }).toThrow('"Required2" is required for Test Tool')
  })

  it.concurrent('should validate all missing parameters at once', () => {
    const toolWithMultipleRequired = {
      ...mockTool,
      params: {
        param1: {
          type: 'string' as const,
          required: true,
          visibility: 'user-or-llm' as const,
          description: 'First parameter',
        },
        param2: {
          type: 'string' as const,
          required: true,
          visibility: 'user-or-llm' as const,
          description: 'Second parameter',
        },
      },
    }

    // Should throw for the first missing parameter it encounters
    expect(() => {
      validateRequiredParametersAfterMerge('test-tool', toolWithMultipleRequired, {})
    }).toThrow('"Param1" is required for Test Tool')
  })
})

describe('executeRequest', () => {
  let mockTool: ToolConfig
  let mockFetch: any

  beforeEach(() => {
    mockFetch = vi.fn()
    global.fetch = mockFetch

    mockTool = {
      id: 'test-tool',
      name: 'Test Tool',
      description: 'A test tool',
      version: '1.0.0',
      params: {},
      request: {
        url: 'https://api.example.com',
        method: 'GET',
        headers: () => ({ 'Content-Type': 'application/json' }),
      },
      transformResponse: vi.fn(async (response) => ({
        success: true,
        output: await response.json(),
      })),
    }
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('should handle successful requests', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: 'success' }),
    })

    const result = await executeRequest('test-tool', mockTool, {
      url: 'https://api.example.com',
      method: 'GET',
      headers: {},
    })

    expect(mockFetch).toHaveBeenCalledWith('https://api.example.com', {
      method: 'GET',
      headers: {},
      body: undefined,
    })
    expect(mockTool.transformResponse).toHaveBeenCalled()
    expect(result).toEqual({
      success: true,
      output: { result: 'success' },
    })
  })

  it.concurrent('should use default transform response if not provided', async () => {
    mockTool.transformResponse = undefined

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: 'success' }),
    })

    const result = await executeRequest('test-tool', mockTool, {
      url: 'https://api.example.com',
      method: 'GET',
      headers: {},
    })

    expect(result).toEqual({
      success: true,
      output: { result: 'success' },
    })
  })

  it('should handle error responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ message: 'Invalid input' }),
    })

    const result = await executeRequest('test-tool', mockTool, {
      url: 'https://api.example.com',
      method: 'GET',
      headers: {},
    })

    expect(result).toEqual({
      success: false,
      output: {},
      error: 'Invalid input',
    })
  })

  it.concurrent('should handle network errors', async () => {
    const networkError = new Error('Network error')
    mockFetch.mockRejectedValueOnce(networkError)

    const result = await executeRequest('test-tool', mockTool, {
      url: 'https://api.example.com',
      method: 'GET',
      headers: {},
    })

    expect(result).toEqual({
      success: false,
      output: {},
      error: 'Network error',
    })
  })

  it('should handle JSON parse errors in error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      json: async () => {
        throw new Error('Invalid JSON')
      },
    })

    const result = await executeRequest('test-tool', mockTool, {
      url: 'https://api.example.com',
      method: 'GET',
      headers: {},
    })

    expect(result).toEqual({
      success: false,
      output: {},
      error: 'Server Error', // Should use statusText in the error message
    })
  })
})

describe('createParamSchema', () => {
  it.concurrent('should create parameter schema from custom tool schema', () => {
    const customTool = {
      id: 'test-tool',
      title: 'Test Tool',
      schema: {
        function: {
          name: 'testFunc',
          description: 'A test function',
          parameters: {
            type: 'object',
            properties: {
              required1: { type: 'string', description: 'Required param' },
              optional1: { type: 'number', description: 'Optional param' },
            },
            required: ['required1'],
          },
        },
      },
    }

    const result = createParamSchema(customTool)

    expect(result).toEqual({
      required1: {
        type: 'string',
        required: true,
        visibility: 'user-or-llm',
        description: 'Required param',
      },
      optional1: {
        type: 'number',
        required: false,
        visibility: 'user-only',
        description: 'Optional param',
      },
    })
  })

  it.concurrent('should handle empty or missing schema gracefully', () => {
    const emptyTool = {
      id: 'empty-tool',
      title: 'Empty Tool',
      schema: {},
    }

    const result = createParamSchema(emptyTool)

    expect(result).toEqual({})

    const missingPropsTool = {
      id: 'missing-props',
      title: 'Missing Props',
      schema: { function: { parameters: {} } },
    }

    const result2 = createParamSchema(missingPropsTool)
    expect(result2).toEqual({})
  })
})

describe('getClientEnvVars', () => {
  it.concurrent('should return environment variables from store in browser environment', () => {
    const mockStoreGetter = () => ({
      getAllVariables: () => ({
        API_KEY: { value: 'mock-api-key' },
        BASE_URL: { value: 'https://example.com' },
      }),
    })

    const result = getClientEnvVars(mockStoreGetter)

    expect(result).toEqual({
      API_KEY: 'mock-api-key',
      BASE_URL: 'https://example.com',
    })
  })

  it.concurrent('should return empty object in server environment', () => {
    global.window = undefined as any

    const result = getClientEnvVars()

    expect(result).toEqual({})
  })
})

describe('createCustomToolRequestBody', () => {
  it.concurrent('should create request body function for client-side execution', () => {
    const customTool = {
      code: 'return a + b',
      schema: {
        function: {
          parameters: { type: 'object', properties: {} },
        },
      },
    }

    const mockStoreGetter = () => ({
      getAllVariables: () => ({
        API_KEY: { value: 'mock-api-key' },
        BASE_URL: { value: 'https://example.com' },
      }),
    })

    const bodyFn = createCustomToolRequestBody(customTool, true, undefined, mockStoreGetter)
    const result = bodyFn({ a: 5, b: 3 })

    expect(result).toEqual({
      code: 'return a + b',
      params: { a: 5, b: 3 },
      schema: { type: 'object', properties: {} },
      envVars: {
        API_KEY: 'mock-api-key',
        BASE_URL: 'https://example.com',
      },
      workflowId: undefined,
      workflowVariables: {},
      blockData: {},
      blockNameMapping: {},
      isCustomTool: true,
    })
  })

  it.concurrent('should create request body function for server-side execution', () => {
    const customTool = {
      code: 'return a + b',
      schema: {
        function: {
          parameters: { type: 'object', properties: {} },
        },
      },
    }

    const workflowId = 'test-workflow-123'
    const bodyFn = createCustomToolRequestBody(customTool, false, workflowId)
    const result = bodyFn({ a: 5, b: 3 })

    expect(result).toEqual({
      code: 'return a + b',
      params: { a: 5, b: 3 },
      schema: { type: 'object', properties: {} },
      envVars: {},
      workflowId: 'test-workflow-123',
      workflowVariables: {},
      blockData: {},
      blockNameMapping: {},
      isCustomTool: true,
    })
  })
})
