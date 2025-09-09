'use client'

import { useCallback, useState } from 'react'
import { createLogger } from '@/lib/logs/console/logger'

const logger = createLogger('useMcpServerTest')

export interface McpServerTestConfig {
  name: string
  transport: 'http' | 'sse' | 'streamable-http'
  url?: string
  headers?: Record<string, string>
  timeout?: number
}

export interface McpServerTestResult {
  success: boolean
  message: string
  error?: string
  negotiatedVersion?: string
  supportedCapabilities?: string[]
  toolCount?: number
  warnings?: string[]
}

export function useMcpServerTest() {
  const [testResult, setTestResult] = useState<McpServerTestResult | null>(null)
  const [isTestingConnection, setIsTestingConnection] = useState(false)

  const testConnection = useCallback(
    async (config: McpServerTestConfig): Promise<McpServerTestResult> => {
      if (!config.name || !config.transport) {
        const result: McpServerTestResult = {
          success: false,
          message: 'Missing required configuration',
          error: 'Please provide both server name and transport method',
        }
        setTestResult(result)
        return result
      }

      if (
        (config.transport === 'http' ||
          config.transport === 'sse' ||
          config.transport === 'streamable-http') &&
        !config.url?.trim()
      ) {
        const result: McpServerTestResult = {
          success: false,
          message: 'Missing server URL',
          error: 'Please provide a server URL for HTTP/SSE transport',
        }
        setTestResult(result)
        return result
      }

      setIsTestingConnection(true)
      setTestResult(null)

      try {
        // Filter out empty headers before sending to API
        const cleanConfig = {
          ...config,
          headers: config.headers
            ? Object.fromEntries(
                Object.entries(config.headers).filter(
                  ([key, value]) => key.trim() !== '' && value.trim() !== ''
                )
              )
            : {},
        }

        const response = await fetch('/api/mcp/servers/test-connection', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(cleanConfig),
        })

        const result = await response.json()

        if (!response.ok) {
          throw new Error(result.error || 'Connection test failed')
        }

        setTestResult(result)
        logger.info(`MCP server test ${result.success ? 'passed' : 'failed'}:`, config.name)
        return result
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
        const result: McpServerTestResult = {
          success: false,
          message: 'Connection failed',
          error: errorMessage,
        }
        setTestResult(result)
        logger.error('MCP server test failed:', errorMessage)
        return result
      } finally {
        setIsTestingConnection(false)
      }
    },
    []
  )

  const clearTestResult = useCallback(() => {
    setTestResult(null)
  }, [])

  return {
    testResult,
    isTestingConnection,
    testConnection,
    clearTestResult,
  }
}

export function getTestResultSummary(result: McpServerTestResult): string {
  if (result.success) {
    let summary = `✓ Connection successful! Protocol: ${result.negotiatedVersion || 'Unknown'}`
    if (result.toolCount !== undefined) {
      summary += `\n${result.toolCount} tool${result.toolCount !== 1 ? 's' : ''} available`
    }
    if (result.supportedCapabilities && result.supportedCapabilities.length > 0) {
      summary += `\nCapabilities: ${result.supportedCapabilities.join(', ')}`
    }
    return summary
  }
  return `✗ Connection failed: ${result.message}${result.error ? `\n${result.error}` : ''}`
}

export function isServerSafeToAdd(result: McpServerTestResult): boolean {
  if (!result.success) return false

  // Check for version compatibility issues
  if (result.warnings?.some((w) => w.toLowerCase().includes('version'))) {
    return false
  }

  return true
}
