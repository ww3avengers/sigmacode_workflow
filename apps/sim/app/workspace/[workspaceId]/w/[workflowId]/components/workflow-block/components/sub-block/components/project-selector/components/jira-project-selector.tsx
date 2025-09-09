'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ExternalLink, RefreshCw, X } from 'lucide-react'
import { JiraIcon } from '@/components/icons'
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
import {
  type Credential,
  getProviderIdFromServiceId,
  getServiceIdFromScopes,
  type OAuthProvider,
} from '@/lib/oauth'
import { OAuthRequiredModal } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/workflow-block/components/sub-block/components/credential-selector/components/oauth-required-modal'

const logger = createLogger('JiraProjectSelector')

export interface JiraProjectInfo {
  id: string
  key: string
  name: string
  url?: string
  avatarUrl?: string
  description?: string
  projectTypeKey?: string
  simplified?: boolean
  style?: string
  isPrivate?: boolean
}

interface JiraProjectSelectorProps {
  value: string
  onChange: (value: string, projectInfo?: JiraProjectInfo) => void
  provider: OAuthProvider
  requiredScopes?: string[]
  label?: string
  disabled?: boolean
  serviceId?: string
  domain: string
  showPreview?: boolean
  onProjectInfoChange?: (projectInfo: JiraProjectInfo | null) => void
  credentialId?: string
  isForeignCredential?: boolean
  workflowId?: string
}

export function JiraProjectSelector({
  value,
  onChange,
  provider,
  requiredScopes = [],
  label = 'Select Jira project',
  disabled = false,
  serviceId,
  domain,
  showPreview = true,
  onProjectInfoChange,
  credentialId,
  isForeignCredential = false,
  workflowId,
}: JiraProjectSelectorProps) {
  const [open, setOpen] = useState(false)
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [projects, setProjects] = useState<JiraProjectInfo[]>([])
  const [selectedCredentialId, setSelectedCredentialId] = useState<string>(credentialId || '')
  const [selectedProjectId, setSelectedProjectId] = useState(value)
  const [selectedProject, setSelectedProject] = useState<JiraProjectInfo | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [showOAuthModal, setShowOAuthModal] = useState(false)
  const initialFetchRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [cloudId, setCloudId] = useState<string | null>(null)

  // Handle search with debounce
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const handleSearch = (value: string) => {
    // Clear any existing timeout
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current)
    }

    // Set a new timeout
    searchTimeoutRef.current = setTimeout(() => {
      if (value.length >= 1) {
        fetchProjects(value)
      } else {
        fetchProjects() // Fetch all projects if no search term
      }
    }, 500) // 500ms debounce
  }

  // Clean up the timeout on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current)
      }
    }
  }, [])

  // Determine the appropriate service ID based on provider and scopes
  const getServiceId = (): string => {
    if (serviceId) return serviceId
    return getServiceIdFromScopes(provider, requiredScopes)
  }

  // Determine the appropriate provider ID based on service and scopes
  const getProviderId = (): string => {
    const effectiveServiceId = getServiceId()
    return getProviderIdFromServiceId(effectiveServiceId)
  }

  // Fetch available credentials for this provider
  const fetchCredentials = useCallback(async () => {
    setIsLoading(true)
    try {
      const providerId = getProviderId()
      const response = await fetch(`/api/auth/oauth/credentials?provider=${providerId}`)

      if (response.ok) {
        const data = await response.json()
        setCredentials(data.credentials)
        // Do not auto-select credentials. Only use the credentialId provided by the parent.
      }
    } catch (error) {
      logger.error('Error fetching credentials:', error)
    } finally {
      setIsLoading(false)
    }
  }, [provider, getProviderId, selectedCredentialId])

  // Fetch detailed project information
  const fetchProjectInfo = useCallback(
    async (projectId: string) => {
      if (!selectedCredentialId || !domain || !projectId) return

      setIsLoading(true)
      setError(null)

      try {
        // Get the access token from the selected credential
        const tokenResponse = await fetch('/api/auth/oauth/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            credentialId: selectedCredentialId,
            workflowId,
          }),
        })

        if (!tokenResponse.ok) {
          const errorData = await tokenResponse.json()
          logger.error('Access token error:', errorData)
          setError('Authentication failed. Please reconnect your Jira account.')
          return
        }

        const tokenData = await tokenResponse.json()
        const accessToken = tokenData.accessToken

        if (!accessToken) {
          logger.error('No access token returned')
          setError('Authentication failed. Please reconnect your Jira account.')
          return
        }

        // Use POST /api/tools/jira/projects to fetch a single project by id
        const response = await fetch(`/api/tools/jira/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain, accessToken, projectId, cloudId }),
        })

        if (!response.ok) {
          const errorData = await response.json()
          logger.error('Jira API error:', errorData)
          throw new Error(errorData.error || 'Failed to fetch project details')
        }

        const json = await response.json()
        const projectInfo = json?.project
        const newCloudId = json?.cloudId

        if (newCloudId) {
          setCloudId(newCloudId)
        }

        if (projectInfo) {
          setSelectedProject(projectInfo)
          onProjectInfoChange?.(projectInfo)
        } else {
          setSelectedProject(null)
          onProjectInfoChange?.(null)
        }
      } catch (error) {
        logger.error('Error fetching project details:', error)
        setError((error as Error).message)
      } finally {
        setIsLoading(false)
      }
    },
    [selectedCredentialId, domain, onProjectInfoChange, cloudId]
  )

  // Fetch projects from Jira
  const fetchProjects = useCallback(
    async (searchQuery?: string) => {
      if (!selectedCredentialId || !domain) return

      // Validate domain format
      const trimmedDomain = domain.trim().toLowerCase()
      if (!trimmedDomain.includes('.')) {
        setError(
          'Invalid domain format. Please provide the full domain (e.g., your-site.atlassian.net)'
        )
        setProjects([])
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      setError(null)

      try {
        // Get the access token from the selected credential
        const tokenResponse = await fetch('/api/auth/oauth/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            credentialId: selectedCredentialId,
            workflowId,
          }),
        })

        if (!tokenResponse.ok) {
          const errorData = await tokenResponse.json()
          logger.error('Access token error:', errorData)
          setError('Authentication failed. Please reconnect your Jira account.')
          setIsLoading(false)
          return
        }

        const tokenData = await tokenResponse.json()
        const accessToken = tokenData.accessToken

        if (!accessToken) {
          logger.error('No access token returned')
          setError('Authentication failed. Please reconnect your Jira account.')
          setIsLoading(false)
          return
        }

        // Build query parameters for the projects endpoint
        const queryParams = new URLSearchParams({
          domain,
          accessToken,
          ...(searchQuery && { query: searchQuery }),
          ...(cloudId && { cloudId }),
        })

        // Use the GET endpoint for project search
        const response = await fetch(`/api/tools/jira/projects?${queryParams.toString()}`)

        if (!response.ok) {
          const errorData = await response.json()
          logger.error('Jira API error:', errorData)
          throw new Error(errorData.error || 'Failed to fetch projects')
        }

        const data = await response.json()

        if (data.cloudId) {
          setCloudId(data.cloudId)
        }

        // Process the projects results
        const foundProjects = data.projects || []
        logger.info(`Received ${foundProjects.length} projects from API`)
        setProjects(foundProjects)

        // If we have a selected project ID, find the project info
        if (selectedProjectId) {
          const projectInfo = foundProjects.find(
            (project: JiraProjectInfo) => project.id === selectedProjectId
          )
          if (projectInfo) {
            setSelectedProject(projectInfo)
            onProjectInfoChange?.(projectInfo)
          } else if (!searchQuery && selectedProjectId) {
            // If we can't find the project in the list, try to fetch it directly
            fetchProjectInfo(selectedProjectId)
          }
        }
      } catch (error) {
        logger.error('Error fetching projects:', error)
        setError((error as Error).message)
        setProjects([])
      } finally {
        setIsLoading(false)
      }
    },
    [
      selectedCredentialId,
      domain,
      selectedProjectId,
      onProjectInfoChange,
      fetchProjectInfo,
      cloudId,
    ]
  )

  // Fetch credentials list when dropdown opens (for account switching UI), not on mount
  useEffect(() => {
    if (open) {
      fetchCredentials()
    }
  }, [open, fetchCredentials])

  // Keep local credential state in sync with persisted credential
  useEffect(() => {
    if (credentialId && credentialId !== selectedCredentialId) {
      setSelectedCredentialId(credentialId)
    }
  }, [credentialId, selectedCredentialId])

  // Fetch the selected project metadata once credentials are ready or changed
  useEffect(() => {
    if (value && selectedCredentialId && domain && domain.includes('.')) {
      if (!selectedProject || selectedProject.id !== value) {
        fetchProjectInfo(value)
      }
    }
  }, [value, selectedCredentialId, domain, fetchProjectInfo, selectedProject])

  // Keep internal selectedProjectId in sync with the value prop
  useEffect(() => {
    if (value !== selectedProjectId) {
      setSelectedProjectId(value)
    }
  }, [value])

  // Clear local preview when value is cleared remotely or via collaborator
  useEffect(() => {
    if (!value) {
      setSelectedProject(null)
      onProjectInfoChange?.(null)
    }
  }, [value, onProjectInfoChange])

  // Handle open change
  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen)
    // Only fetch projects when a credential is present; otherwise, do nothing
    if (isOpen && selectedCredentialId && domain && domain.includes('.')) {
      fetchProjects('')
    }
  }

  // Handle project selection
  const handleSelectProject = (project: JiraProjectInfo) => {
    setSelectedProjectId(project.id)
    setSelectedProject(project)
    onChange(project.id, project)
    onProjectInfoChange?.(project)
    setOpen(false)
  }

  // Handle adding a new credential
  const handleAddCredential = () => {
    // Show the OAuth modal
    setShowOAuthModal(true)
    setOpen(false)
  }

  // Clear selection
  const handleClearSelection = () => {
    setSelectedProjectId('')
    setSelectedProject(null)
    setError(null)
    onChange('', undefined)
    onProjectInfoChange?.(null)
  }

  const canShowPreview = !!(showPreview && selectedProject && value && selectedProject.id === value)

  return (
    <>
      <div className='space-y-2'>
        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>
            <Button
              variant='outline'
              role='combobox'
              aria-expanded={open}
              className='w-full justify-between'
              disabled={disabled || !domain || !selectedCredentialId || isForeignCredential}
            >
              {canShowPreview ? (
                <div className='flex items-center gap-2 overflow-hidden'>
                  <JiraIcon className='h-4 w-4' />
                  <span className='truncate font-normal'>{selectedProject.name}</span>
                </div>
              ) : selectedProjectId ? (
                <div className='flex items-center gap-2 overflow-hidden'>
                  <JiraIcon className='h-4 w-4' />
                  <span className='truncate font-normal'>{selectedProjectId}</span>
                </div>
              ) : (
                <div className='flex items-center gap-2'>
                  <JiraIcon className='h-4 w-4' />
                  <span className='text-muted-foreground'>{label}</span>
                </div>
              )}
              <ChevronDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
            </Button>
          </PopoverTrigger>
          {!isForeignCredential && (
            <PopoverContent className='w-[300px] p-0' align='start'>
              {selectedCredentialId && credentials.length > 0 && (
                <div className='flex items-center justify-between border-b px-3 py-2'>
                  <div className='flex items-center gap-2'>
                    <JiraIcon className='h-4 w-4' />
                    <span className='text-muted-foreground text-xs'>
                      {credentials.find((cred) => cred.id === selectedCredentialId)?.name ||
                        'Unknown'}
                    </span>
                  </div>
                  {credentials.length > 1 && (
                    <Button
                      variant='ghost'
                      size='sm'
                      className='h-6 px-2 text-xs'
                      onClick={() => setOpen(true)}
                    >
                      Switch
                    </Button>
                  )}
                </div>
              )}

              <Command>
                <CommandInput placeholder='Search projects...' onValueChange={handleSearch} />
                <CommandList>
                  <CommandEmpty>
                    {isLoading ? (
                      <div className='flex items-center justify-center p-4'>
                        <RefreshCw className='h-4 w-4 animate-spin' />
                        <span className='ml-2'>Loading projects...</span>
                      </div>
                    ) : error ? (
                      <div className='p-4 text-center'>
                        <p className='text-destructive text-sm'>{error}</p>
                      </div>
                    ) : credentials.length === 0 ? (
                      <div className='p-4 text-center'>
                        <p className='font-medium text-sm'>No accounts connected.</p>
                        <p className='text-muted-foreground text-xs'>
                          Connect a Jira account to continue.
                        </p>
                      </div>
                    ) : (
                      <div className='p-4 text-center'>
                        <p className='font-medium text-sm'>No projects found.</p>
                        <p className='text-muted-foreground text-xs'>
                          Try a different search or account.
                        </p>
                      </div>
                    )}
                  </CommandEmpty>

                  {/* Account selection - only show if we have multiple accounts */}
                  {credentials.length > 1 && (
                    <CommandGroup>
                      <div className='px-2 py-1.5 font-medium text-muted-foreground text-xs'>
                        Switch Account
                      </div>
                      {credentials.map((cred) => (
                        <CommandItem
                          key={cred.id}
                          value={`account-${cred.id}`}
                          onSelect={() => setSelectedCredentialId(cred.id)}
                        >
                          <div className='flex items-center gap-2'>
                            <JiraIcon className='h-4 w-4' />
                            <span className='font-normal'>{cred.name}</span>
                          </div>
                          {cred.id === selectedCredentialId && (
                            <Check className='ml-auto h-4 w-4' />
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}

                  {/* Projects list */}
                  {projects.length > 0 && (
                    <CommandGroup>
                      <div className='px-2 py-1.5 font-medium text-muted-foreground text-xs'>
                        Projects
                      </div>
                      {projects.map((project) => (
                        <CommandItem
                          key={project.id}
                          value={`project-${project.id}-${project.name}`}
                          onSelect={() => handleSelectProject(project)}
                        >
                          <div className='flex items-center gap-2 overflow-hidden'>
                            {project.avatarUrl ? (
                              <img
                                src={project.avatarUrl}
                                alt={project.name}
                                className='h-4 w-4 rounded'
                              />
                            ) : (
                              <JiraIcon className='h-4 w-4' />
                            )}
                            <span className='truncate font-normal'>{project.name}</span>
                          </div>
                          {project.id === selectedProjectId && (
                            <Check className='ml-auto h-4 w-4' />
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}

                  {/* Connect account option - only show if no credentials */}
                  {credentials.length === 0 && (
                    <CommandGroup>
                      <CommandItem onSelect={handleAddCredential}>
                        <div className='flex items-center gap-2 text-foreground'>
                          <JiraIcon className='h-4 w-4' />
                          <span>Connect Jira account</span>
                        </div>
                      </CommandItem>
                    </CommandGroup>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          )}
        </Popover>

        {/* Project preview */}
        {canShowPreview && (
          <div className='relative mt-2 rounded-md border border-muted bg-muted/10 p-2'>
            <div className='absolute top-2 right-2'>
              <Button
                variant='ghost'
                size='icon'
                className='h-5 w-5 hover:bg-muted'
                onClick={handleClearSelection}
              >
                <X className='h-3 w-3' />
              </Button>
            </div>
            <div className='flex items-center gap-3 pr-4'>
              <div className='flex h-6 w-6 flex-shrink-0 items-center justify-center rounded bg-muted/20'>
                {selectedProject.avatarUrl ? (
                  <img
                    src={selectedProject.avatarUrl}
                    alt={selectedProject.name}
                    className='h-4 w-4 rounded'
                  />
                ) : (
                  <JiraIcon className='h-4 w-4' />
                )}
              </div>
              <div className='min-w-0 flex-1 overflow-hidden'>
                <div className='flex items-center gap-2'>
                  <h4 className='truncate font-medium text-xs'>{selectedProject.name}</h4>
                  <span className='whitespace-nowrap text-muted-foreground text-xs'>
                    {selectedProject.key}
                  </span>
                </div>
                {selectedProject.url && (
                  <a
                    href={selectedProject.url}
                    target='_blank'
                    rel='noopener noreferrer'
                    className='flex items-center gap-1 text-foreground text-xs hover:underline'
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span>Open in Jira</span>
                    <ExternalLink className='h-3 w-3' />
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {showOAuthModal && (
        <OAuthRequiredModal
          isOpen={showOAuthModal}
          onClose={() => setShowOAuthModal(false)}
          provider={provider}
          toolName='Jira'
          requiredScopes={requiredScopes}
          serviceId={getServiceId()}
        />
      )}
    </>
  )
}
