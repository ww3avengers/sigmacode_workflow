'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { createLogger } from '@/lib/logs/console/logger'
import { useSubBlockValue } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/workflow-block/components/sub-block/hooks/use-sub-block-value'
import type { SubBlockConfig } from '@/blocks/types'
import { useMcpTools } from '@/hooks/use-mcp-tools'

const logger = createLogger('McpToolSelector')

interface McpToolSelectorProps {
  blockId: string
  subBlock: SubBlockConfig
  disabled?: boolean
  isPreview?: boolean
  previewValue?: string | null
}

export function McpToolSelector({
  blockId,
  subBlock,
  disabled = false,
  isPreview = false,
  previewValue,
}: McpToolSelectorProps) {
  const [open, setOpen] = useState(false)

  // Get MCP tools from hook
  const { mcpTools, isLoading, error, refreshTools, getToolsByServer } = useMcpTools()

  // Use collaborative state management via useSubBlockValue hook
  const [storeValue, setStoreValue] = useSubBlockValue(blockId, subBlock.id)

  // Get the server selection from the dependent field
  const [serverValue] = useSubBlockValue(blockId, 'server')

  // Extract config values
  const label = subBlock.placeholder || 'Select tool'

  // Get the effective value (preview or store value)
  const effectiveValue = isPreview && previewValue !== undefined ? previewValue : storeValue
  const selectedToolId = effectiveValue || ''

  // Get available tools for the selected server
  const availableTools = useMemo(() => {
    if (!serverValue) return []
    return getToolsByServer(serverValue)
  }, [serverValue, getToolsByServer])

  // Get the selected tool
  const selectedTool = availableTools.find((tool) => tool.id === selectedToolId)

  // Clear tool selection when server changes (but not when tools are still loading)
  useEffect(() => {
    // Only clear if we have a stored value, tools are loaded, and the tool doesn't exist
    if (
      storeValue &&
      availableTools.length > 0 &&
      !availableTools.find((tool) => tool.id === storeValue)
    ) {
      if (!isPreview) {
        setStoreValue('')
      }
    }
  }, [serverValue, availableTools, storeValue, setStoreValue, isPreview])

  // Handle popover open to refresh tools
  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen)
    if (isOpen && serverValue) {
      refreshTools()
    }
  }

  // Handle tool selection
  const handleSelect = (toolId: string) => {
    if (!isPreview) {
      setStoreValue(toolId)
    }
    setOpen(false)
  }

  // Get display text for selected tool
  const getDisplayText = () => {
    if (selectedTool) {
      return <span className='truncate font-normal'>{selectedTool.name}</span>
    }
    return (
      <span className='truncate text-muted-foreground'>
        {serverValue ? label : 'Select server first'}
      </span>
    )
  }

  // Don't show anything if no server is selected
  const isDisabled = disabled || !serverValue

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='relative w-full justify-between'
          disabled={isDisabled}
        >
          <div className='flex max-w-[calc(100%-20px)] items-center overflow-hidden'>
            {getDisplayText()}
          </div>
          <ChevronDown className='absolute right-3 h-4 w-4 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[250px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search tools...' />
          <CommandList>
            <CommandEmpty>
              {isLoading ? (
                <div className='flex items-center justify-center p-4'>
                  <RefreshCw className='h-4 w-4 animate-spin' />
                  <span className='ml-2'>Loading tools...</span>
                </div>
              ) : error ? (
                <div className='p-4 text-center'>
                  <p className='font-medium text-destructive text-sm'>Error loading tools</p>
                  <p className='text-muted-foreground text-xs'>{error}</p>
                </div>
              ) : !serverValue ? (
                <div className='p-4 text-center'>
                  <p className='font-medium text-sm'>No server selected</p>
                  <p className='text-muted-foreground text-xs'>
                    Select an MCP server first to see available tools
                  </p>
                </div>
              ) : (
                <div className='p-4 text-center'>
                  <p className='font-medium text-sm'>No tools found</p>
                  <p className='text-muted-foreground text-xs'>
                    The selected server has no available tools
                  </p>
                </div>
              )}
            </CommandEmpty>
            {availableTools.length > 0 && (
              <CommandGroup>
                {availableTools.map((tool) => (
                  <CommandItem
                    key={tool.id}
                    value={`tool-${tool.id}-${tool.name}`}
                    onSelect={() => handleSelect(tool.id)}
                    className='cursor-pointer'
                  >
                    <div className='flex items-center gap-2 overflow-hidden'>
                      <span className='truncate font-normal'>{tool.name}</span>
                    </div>
                    {tool.id === selectedToolId && <Check className='ml-auto h-4 w-4' />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
