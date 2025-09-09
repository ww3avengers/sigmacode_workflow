import { createHmac } from 'crypto'
import { task } from '@trigger.dev/sdk'
import { eq } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { createLogger } from '@/lib/logs/console/logger'
import type { WorkflowExecutionLog } from '@/lib/logs/types'
import { decryptSecret } from '@/lib/utils'
import { db } from '@/db'
import { workflowLogWebhook, workflowLogWebhookDelivery } from '@/db/schema'

const logger = createLogger('LogsWebhookDelivery')

const MAX_ATTEMPTS = 10
const RETRY_DELAYS = [
  60 * 1000, // 1 minute
  5 * 60 * 1000, // 5 minutes
  15 * 60 * 1000, // 15 minutes
  60 * 60 * 1000, // 1 hour
  2 * 60 * 60 * 1000, // 2 hours
  4 * 60 * 60 * 1000, // 4 hours
  8 * 60 * 60 * 1000, // 8 hours
  12 * 60 * 60 * 1000, // 12 hours
  24 * 60 * 60 * 1000, // 24 hours
  24 * 60 * 60 * 1000, // 24 hours (repeat for last attempt)
]

interface WebhookPayload {
  id: string
  type: 'workflow.execution.completed'
  timestamp: number
  data: {
    workflowId: string
    executionId: string
    status: 'success' | 'error'
    level: string
    trigger: string
    startedAt: string
    endedAt: string
    totalDurationMs: number
    cost?: any
    files?: any
    finalOutput?: any
    traceSpans?: any[]
  }
  links: {
    log: string
    execution: string
  }
}

function generateSignature(secret: string, timestamp: number, body: string): string {
  const signatureBase = `${timestamp}.${body}`
  const hmac = createHmac('sha256', secret)
  hmac.update(signatureBase)
  return hmac.digest('hex')
}

export const logsWebhookDelivery = task({
  id: 'logs-webhook-delivery',
  retry: {
    maxAttempts: MAX_ATTEMPTS,
  },
  run: async (params: {
    deliveryId: string
    subscriptionId: string
    log: WorkflowExecutionLog
  }) => {
    const { deliveryId, subscriptionId, log } = params

    try {
      const [subscription] = await db
        .select()
        .from(workflowLogWebhook)
        .where(eq(workflowLogWebhook.id, subscriptionId))
        .limit(1)

      if (!subscription || !subscription.active) {
        logger.warn(`Subscription ${subscriptionId} not found or inactive`)
        await db
          .update(workflowLogWebhookDelivery)
          .set({
            status: 'failed',
            errorMessage: 'Subscription not found or inactive',
            updatedAt: new Date(),
          })
          .where(eq(workflowLogWebhookDelivery.id, deliveryId))
        return
      }

      const [delivery] = await db
        .select()
        .from(workflowLogWebhookDelivery)
        .where(eq(workflowLogWebhookDelivery.id, deliveryId))
        .limit(1)

      if (!delivery) {
        logger.error(`Delivery ${deliveryId} not found`)
        return
      }

      const attempts = delivery.attempts + 1
      const timestamp = Date.now()
      const eventId = `evt_${uuidv4()}`

      const payload: WebhookPayload = {
        id: eventId,
        type: 'workflow.execution.completed',
        timestamp,
        data: {
          workflowId: log.workflowId,
          executionId: log.executionId,
          status: log.level === 'error' ? 'error' : 'success',
          level: log.level,
          trigger: log.trigger,
          startedAt: log.startedAt,
          endedAt: log.endedAt || log.startedAt,
          totalDurationMs: log.totalDurationMs,
          cost: log.cost,
          files: (log as any).files,
        },
        links: {
          log: `/v1/logs/${log.id}`,
          execution: `/v1/logs/executions/${log.executionId}`,
        },
      }

      if (subscription.includeFinalOutput && log.executionData) {
        payload.data.finalOutput = (log.executionData as any).finalOutput
      }

      if (subscription.includeTraceSpans && log.executionData) {
        payload.data.traceSpans = (log.executionData as any).traceSpans
      }

      const body = JSON.stringify(payload)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'sim-event': 'workflow.execution.completed',
        'sim-timestamp': timestamp.toString(),
        'sim-delivery-id': deliveryId,
        'Idempotency-Key': deliveryId,
      }

      if (subscription.secret) {
        const { decrypted } = await decryptSecret(subscription.secret)
        const signature = generateSignature(decrypted, timestamp, body)
        headers['sim-signature'] = `t=${timestamp},v1=${signature}`
      }

      logger.info(`Attempting webhook delivery ${deliveryId} (attempt ${attempts})`, {
        url: subscription.url,
        executionId: log.executionId,
      })

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 30000)

      try {
        const response = await fetch(subscription.url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        const responseBody = await response.text().catch(() => '')
        const truncatedBody = responseBody.slice(0, 1000)

        if (response.ok) {
          await db
            .update(workflowLogWebhookDelivery)
            .set({
              status: 'success',
              attempts,
              lastAttemptAt: new Date(),
              responseStatus: response.status,
              responseBody: truncatedBody,
              errorMessage: null,
              updatedAt: new Date(),
            })
            .where(eq(workflowLogWebhookDelivery.id, deliveryId))

          logger.info(`Webhook delivery ${deliveryId} succeeded`, {
            status: response.status,
            executionId: log.executionId,
          })

          return { success: true }
        }

        const isRetryable = response.status >= 500 || response.status === 429

        if (!isRetryable || attempts >= MAX_ATTEMPTS) {
          await db
            .update(workflowLogWebhookDelivery)
            .set({
              status: 'failed',
              attempts,
              lastAttemptAt: new Date(),
              responseStatus: response.status,
              responseBody: truncatedBody,
              errorMessage: `HTTP ${response.status}`,
              updatedAt: new Date(),
            })
            .where(eq(workflowLogWebhookDelivery.id, deliveryId))

          logger.warn(`Webhook delivery ${deliveryId} failed permanently`, {
            status: response.status,
            attempts,
            executionId: log.executionId,
          })

          return { success: false }
        }

        const nextDelay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]
        const nextAttemptAt = new Date(Date.now() + nextDelay)

        await db
          .update(workflowLogWebhookDelivery)
          .set({
            status: 'pending',
            attempts,
            lastAttemptAt: new Date(),
            nextAttemptAt,
            responseStatus: response.status,
            responseBody: truncatedBody,
            errorMessage: `HTTP ${response.status} - retrying`,
            updatedAt: new Date(),
          })
          .where(eq(workflowLogWebhookDelivery.id, deliveryId))

        throw new Error(`HTTP ${response.status} - retryable error`)
      } catch (error: any) {
        clearTimeout(timeoutId)

        if (error.name === 'AbortError') {
          logger.error(`Webhook delivery ${deliveryId} timed out`, {
            executionId: log.executionId,
            attempts,
          })
          error.message = 'Request timeout after 30 seconds'
        }

        const nextDelay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]
        const nextAttemptAt = new Date(Date.now() + nextDelay)

        await db
          .update(workflowLogWebhookDelivery)
          .set({
            status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
            attempts,
            lastAttemptAt: new Date(),
            nextAttemptAt: attempts >= MAX_ATTEMPTS ? null : nextAttemptAt,
            errorMessage: error.message,
            updatedAt: new Date(),
          })
          .where(eq(workflowLogWebhookDelivery.id, deliveryId))

        if (attempts >= MAX_ATTEMPTS) {
          logger.error(`Webhook delivery ${deliveryId} failed after ${attempts} attempts`, {
            error: error.message,
            executionId: log.executionId,
          })
          return { success: false }
        }

        throw error
      }
    } catch (error: any) {
      logger.error(`Webhook delivery ${deliveryId} encountered error`, {
        error: error.message,
        stack: error.stack,
      })
      throw error
    }
  },
})
