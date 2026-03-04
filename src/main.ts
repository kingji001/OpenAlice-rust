import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import { Engine } from './core/engine.js'
import { loadConfig } from './core/config.js'
import type { Plugin, EngineContext, ReconnectResult } from './core/types.js'
import { McpPlugin } from './plugins/mcp.js'
import { TelegramPlugin } from './connectors/telegram/index.js'
import { WebPlugin } from './connectors/web/index.js'
import { McpAskPlugin } from './connectors/mcp-ask/index.js'
import { createThinkingTools } from './extension/thinking-kit/index.js'
import {
  AccountManager,
  wireAccountTrading,
  createAlpacaFromConfig,
  createCcxtFromConfig,
  createTradingTools,
} from './extension/trading/index.js'
import type { AccountSetup, GitExportState, ITradingGit } from './extension/trading/index.js'
import { Brain, createBrainTools } from './extension/brain/index.js'
import type { BrainExportState } from './extension/brain/index.js'
import { createBrowserTools } from './extension/browser/index.js'
import { OpenBBEquityClient, SymbolIndex } from './openbb/equity/index.js'
import { createEquityTools } from './extension/equity/index.js'
import { OpenBBCryptoClient } from './openbb/crypto/index.js'
import { OpenBBCurrencyClient } from './openbb/currency/index.js'
import { OpenBBEconomyClient } from './openbb/economy/index.js'
import { OpenBBCommodityClient } from './openbb/commodity/index.js'
import { OpenBBNewsClient } from './openbb/news/index.js'
import { createCryptoTools } from './extension/crypto/index.js'
import { createCurrencyTools } from './extension/currency/index.js'
import { createNewsTools } from './extension/news/index.js'
import { createAnalysisTools } from './extension/analysis-kit/index.js'
import { SessionStore } from './core/session.js'
import { ConnectorCenter } from './core/connector-center.js'
import { ToolCenter } from './core/tool-center.js'
import { AgentCenter } from './core/agent-center.js'
import { ProviderRouter } from './core/ai-provider.js'
import { VercelAIProvider } from './ai-providers/vercel-ai-sdk/vercel-provider.js'
import { ClaudeCodeProvider } from './ai-providers/claude-code/claude-code-provider.js'
import { createEventLog } from './core/event-log.js'
import { createCronEngine, createCronListener, createCronTools } from './task/cron/index.js'
import { createHeartbeat } from './task/heartbeat/index.js'
import { NewsCollectorStore, NewsCollector, wrapNewsToolsForPiggyback, createNewsArchiveTools } from './extension/news-collector/index.js'

// ==================== Persistence paths ====================

const CRYPTO_GIT_FILE = resolve('data/crypto-trading/commit.json')
const SEC_GIT_FILE = resolve('data/securities-trading/commit.json')
const BRAIN_FILE = resolve('data/brain/commit.json')
const FRONTAL_LOBE_FILE = resolve('data/brain/frontal-lobe.md')
const EMOTION_LOG_FILE = resolve('data/brain/emotion-log.md')
const PERSONA_FILE = resolve('data/brain/persona.md')
const PERSONA_DEFAULT = resolve('data/default/persona.default.md')

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Read a file, copying from default if it doesn't exist yet. */
async function readWithDefault(target: string, defaultFile: string): Promise<string> {
  try { return await readFile(target, 'utf-8') } catch { /* not found — copy default */ }
  try {
    const content = await readFile(defaultFile, 'utf-8')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    return content
  } catch { return '' }
}

/** Create a git commit persistence callback for a given file path. */
function createGitPersister(filePath: string) {
  return async (state: GitExportState) => {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(state, null, 2))
  }
}

/** Read saved git state from disk. */
async function loadGitState(filePath: string): Promise<GitExportState | undefined> {
  return readFile(filePath, 'utf-8')
    .then((r) => JSON.parse(r) as GitExportState)
    .catch(() => undefined)
}

async function main() {
  const config = await loadConfig()

  // ==================== Trading Account Manager ====================

  const accountManager = new AccountManager()
  // Mutable map: accountId → { setup, gitFilePath }
  // Needed for reconnect (re-wiring) and git lookups.
  const accountSetups = new Map<string, { setup: AccountSetup; gitFilePath: string }>()

  // ==================== Alpaca (securities) — sync init ====================

  const alpacaAccount = createAlpacaFromConfig(config.securities)
  let alpacaReady = false

  if (alpacaAccount) {
    try {
      await alpacaAccount.init()
      const savedState = await loadGitState(SEC_GIT_FILE)
      const setup = wireAccountTrading(alpacaAccount, {
        guards: config.securities.guards,
        savedState,
        onCommit: createGitPersister(SEC_GIT_FILE),
      })
      accountManager.addAccount(alpacaAccount)
      accountSetups.set(alpacaAccount.id, { setup, gitFilePath: SEC_GIT_FILE })
      alpacaReady = true
      console.log(`trading: ${alpacaAccount.label} initialized`)
    } catch (err) {
      console.warn('trading: alpaca init failed (non-fatal):', err)
    }
  }

  // ==================== CCXT (crypto) — async background init ====================

  const ccxtAccount = createCcxtFromConfig(config.crypto)

  // CCXT init is slow (loadMarkets with retries). Start in background, register tools when ready.
  const ccxtInitPromise = ccxtAccount
    ? (async () => {
        try {
          await ccxtAccount.init()
          return ccxtAccount
        } catch (err) {
          console.warn('trading: ccxt init failed (non-fatal):', err)
          return null
        }
      })()
    : Promise.resolve(null)

  // ==================== Brain ====================

  const [brainExport, persona] = await Promise.all([
    readFile(BRAIN_FILE, 'utf-8').then((r) => JSON.parse(r) as BrainExportState).catch(() => undefined),
    readWithDefault(PERSONA_FILE, PERSONA_DEFAULT),
  ])

  const brainDir = resolve('data/brain')
  const brainOnCommit = async (state: BrainExportState) => {
    await mkdir(brainDir, { recursive: true })
    await writeFile(BRAIN_FILE, JSON.stringify(state, null, 2))
    await writeFile(FRONTAL_LOBE_FILE, state.state.frontalLobe)
    const latest = state.commits[state.commits.length - 1]
    if (latest?.type === 'emotion') {
      const prev = state.commits.length > 1
        ? state.commits[state.commits.length - 2]?.stateAfter.emotion ?? 'unknown'
        : 'unknown'
      await appendFile(EMOTION_LOG_FILE,
        `## ${latest.timestamp}\n**${prev} → ${latest.stateAfter.emotion}**\n${latest.message}\n\n`)
    }
  }

  const brain = brainExport
    ? Brain.restore(brainExport, { onCommit: brainOnCommit })
    : new Brain({ onCommit: brainOnCommit })

  const frontalLobe = brain.getFrontalLobe()
  const emotion = brain.getEmotion().current
  const instructions = [
    persona,
    '---',
    '## Current Brain State',
    '',
    `**Frontal Lobe:** ${frontalLobe || '(empty)'}`,
    '',
    `**Emotion:** ${emotion}`,
  ].join('\n')

  // ==================== Event Log ====================

  const eventLog = await createEventLog()

  // ==================== Cron ====================

  const cronEngine = createCronEngine({ eventLog })

  // ==================== News Collector Store ====================

  const newsStore = new NewsCollectorStore({
    maxInMemory: config.newsCollector.maxInMemory,
    retentionDays: config.newsCollector.retentionDays,
  })
  await newsStore.init()

  // ==================== OpenBB Clients ====================

  const providerKeys = config.openbb.providerKeys
  const { providers } = config.openbb
  const equityClient = new OpenBBEquityClient(config.openbb.apiUrl, providers.equity, providerKeys)
  const cryptoClient = new OpenBBCryptoClient(config.openbb.apiUrl, providers.crypto, providerKeys)
  const currencyClient = new OpenBBCurrencyClient(config.openbb.apiUrl, providers.currency, providerKeys)
  const commodityClient = new OpenBBCommodityClient(config.openbb.apiUrl, undefined, providerKeys)
  const economyClient = new OpenBBEconomyClient(config.openbb.apiUrl, undefined, providerKeys)
  const newsClient = new OpenBBNewsClient(config.openbb.apiUrl, undefined, providerKeys)

  // ==================== Equity Symbol Index ====================

  const symbolIndex = new SymbolIndex()
  await symbolIndex.load(equityClient)

  // ==================== Tool Center ====================

  const toolCenter = new ToolCenter()
  toolCenter.register(createThinkingTools(), 'thinking')

  // One unified set of trading tools — routes via `source` parameter at runtime
  toolCenter.register(
    createTradingTools({
      accountManager,
      getGit: (id) => accountSetups.get(id)?.setup.git,
      getGitState: (id) => accountSetups.get(id)?.setup.getGitState(),
    }),
    'trading',
  )

  toolCenter.register(createBrainTools(brain), 'brain')
  toolCenter.register(createBrowserTools(), 'browser')
  toolCenter.register(createCronTools(cronEngine), 'cron')
  toolCenter.register(createEquityTools(symbolIndex, equityClient), 'equity')
  toolCenter.register(createCryptoTools(cryptoClient), 'crypto-data')
  toolCenter.register(createCurrencyTools(currencyClient), 'currency-data')
  let newsTools = createNewsTools(newsClient, {
    companyProvider: providers.newsCompany,
    worldProvider: providers.newsWorld,
  })
  if (config.newsCollector.piggybackOpenBB) {
    newsTools = wrapNewsToolsForPiggyback(newsTools, newsStore)
  }
  toolCenter.register(newsTools, 'news')
  if (config.newsCollector.enabled) {
    toolCenter.register(createNewsArchiveTools(newsStore), 'news-archive')
  }
  toolCenter.register(createAnalysisTools(equityClient, cryptoClient, currencyClient), 'analysis')

  console.log(`tool-center: ${toolCenter.list().length} tools registered`)

  // ==================== AI Provider Chain ====================

  const vercelProvider = new VercelAIProvider(
    () => toolCenter.getVercelTools(),
    instructions,
    config.agent.maxSteps,
    config.compaction,
  )
  const claudeCodeProvider = new ClaudeCodeProvider(config.compaction, instructions)
  const router = new ProviderRouter(vercelProvider, claudeCodeProvider)

  const agentCenter = new AgentCenter(router)
  const engine = new Engine({ agentCenter })

  // ==================== Connector Center ====================

  const connectorCenter = new ConnectorCenter(eventLog)

  // ==================== Cron Lifecycle ====================

  await cronEngine.start()
  const cronSession = new SessionStore('cron/default')
  await cronSession.restore()
  const cronListener = createCronListener({ connectorCenter, eventLog, engine, session: cronSession })
  cronListener.start()
  console.log('cron: engine + listener started')

  // ==================== Heartbeat ====================

  const heartbeat = createHeartbeat({
    config: config.heartbeat,
    connectorCenter, cronEngine, eventLog, engine,
  })
  await heartbeat.start()
  if (config.heartbeat.enabled) {
    console.log(`heartbeat: enabled (every ${config.heartbeat.every})`)
  }

  // ==================== News Collector ====================

  let newsCollector: NewsCollector | null = null
  if (config.newsCollector.enabled && config.newsCollector.feeds.length > 0) {
    newsCollector = new NewsCollector({
      store: newsStore,
      feeds: config.newsCollector.feeds,
      intervalMs: config.newsCollector.intervalMinutes * 60 * 1000,
    })
    newsCollector.start()
    console.log(`news-collector: started (${config.newsCollector.feeds.length} feeds, every ${config.newsCollector.intervalMinutes}m)`)
  }

  // ==================== Account Reconnect ====================

  const reconnectingAccounts = new Set<string>()

  const reconnectAccount = async (accountId: string): Promise<ReconnectResult> => {
    if (reconnectingAccounts.has(accountId)) {
      return { success: false, error: 'Reconnect already in progress' }
    }
    reconnectingAccounts.add(accountId)
    try {
      const freshConfig = await loadConfig()
      const entry = accountSetups.get(accountId)

      // Determine provider type from current account or ID pattern
      const currentAccount = accountManager.getAccount(accountId)
      const provider = currentAccount?.provider ?? (accountId.startsWith('alpaca') ? 'alpaca' : 'ccxt')

      // Close old account
      if (currentAccount) {
        await currentAccount.close()
        accountManager.removeAccount(accountId)
        accountSetups.delete(accountId)
      }

      if (provider === 'alpaca') {
        const newAccount = createAlpacaFromConfig(freshConfig.securities)
        if (!newAccount) {
          return { success: true, message: 'Securities trading disabled (provider: none)' }
        }
        await newAccount.init()
        const savedState = await loadGitState(SEC_GIT_FILE)
        const setup = wireAccountTrading(newAccount, {
          guards: freshConfig.securities.guards,
          savedState,
          onCommit: createGitPersister(SEC_GIT_FILE),
        })
        accountManager.addAccount(newAccount)
        accountSetups.set(newAccount.id, { setup, gitFilePath: SEC_GIT_FILE })
        console.log(`reconnect: ${newAccount.label} online`)
        return { success: true, message: `${newAccount.label} reconnected` }
      } else {
        // CCXT
        const newAccount = createCcxtFromConfig(freshConfig.crypto)
        if (!newAccount) {
          return { success: true, message: 'Crypto trading disabled (provider: none)' }
        }
        await newAccount.init()
        const savedState = await loadGitState(CRYPTO_GIT_FILE)
        const setup = wireAccountTrading(newAccount, {
          guards: freshConfig.crypto.guards,
          savedState,
          onCommit: createGitPersister(CRYPTO_GIT_FILE),
        })
        accountManager.addAccount(newAccount)
        accountSetups.set(newAccount.id, { setup, gitFilePath: CRYPTO_GIT_FILE })
        console.log(`reconnect: ${newAccount.label} online`)
        return { success: true, message: `${newAccount.label} reconnected` }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`reconnect: ${accountId} failed:`, msg)
      return { success: false, error: msg }
    } finally {
      reconnectingAccounts.delete(accountId)
    }
  }

  // ==================== Plugins ====================

  // Core plugins — always-on, not toggleable at runtime
  const corePlugins: Plugin[] = []

  // MCP Server is always active when a port is set — Claude Code provider depends on it for tools
  if (config.connectors.mcp.port) {
    corePlugins.push(new McpPlugin(toolCenter, config.connectors.mcp.port))
  }

  // Web UI is always active (no enabled flag)
  if (config.connectors.web.port) {
    corePlugins.push(new WebPlugin({ port: config.connectors.web.port }))
  }

  // Optional plugins — toggleable at runtime via reconnectConnectors()
  const optionalPlugins = new Map<string, Plugin>()

  if (config.connectors.mcpAsk.enabled && config.connectors.mcpAsk.port) {
    optionalPlugins.set('mcp-ask', new McpAskPlugin({ port: config.connectors.mcpAsk.port }))
  }

  if (config.connectors.telegram.enabled && config.connectors.telegram.botToken) {
    optionalPlugins.set('telegram', new TelegramPlugin({
      token: config.connectors.telegram.botToken,
      allowedChatIds: config.connectors.telegram.chatIds,
    }))
  }

  // ==================== Connector Reconnect ====================

  let connectorsReconnecting = false
  const reconnectConnectors = async (): Promise<ReconnectResult> => {
    if (connectorsReconnecting) return { success: false, error: 'Reconnect already in progress' }
    connectorsReconnecting = true
    try {
      const fresh = await loadConfig()
      const changes: string[] = []

      // --- MCP Ask ---
      const mcpAskWanted = fresh.connectors.mcpAsk.enabled && !!fresh.connectors.mcpAsk.port
      const mcpAskRunning = optionalPlugins.has('mcp-ask')
      if (mcpAskRunning && !mcpAskWanted) {
        await optionalPlugins.get('mcp-ask')!.stop()
        optionalPlugins.delete('mcp-ask')
        changes.push('mcp-ask stopped')
      } else if (!mcpAskRunning && mcpAskWanted) {
        const p = new McpAskPlugin({ port: fresh.connectors.mcpAsk.port! })
        await p.start(ctx)
        optionalPlugins.set('mcp-ask', p)
        changes.push('mcp-ask started')
      }

      // --- Telegram ---
      const telegramWanted = fresh.connectors.telegram.enabled && !!fresh.connectors.telegram.botToken
      const telegramRunning = optionalPlugins.has('telegram')
      if (telegramRunning && !telegramWanted) {
        await optionalPlugins.get('telegram')!.stop()
        optionalPlugins.delete('telegram')
        changes.push('telegram stopped')
      } else if (!telegramRunning && telegramWanted) {
        const p = new TelegramPlugin({
          token: fresh.connectors.telegram.botToken!,
          allowedChatIds: fresh.connectors.telegram.chatIds,
        })
        await p.start(ctx)
        optionalPlugins.set('telegram', p)
        changes.push('telegram started')
      }

      if (changes.length > 0) {
        console.log(`reconnect: connectors — ${changes.join(', ')}`)
      }
      return { success: true, message: changes.length > 0 ? changes.join(', ') : 'no changes' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('reconnect: connectors failed:', msg)
      return { success: false, error: msg }
    } finally {
      connectorsReconnecting = false
    }
  }

  // ==================== Engine Context ====================

  const ctx: EngineContext = {
    config, connectorCenter, engine, eventLog, heartbeat, cronEngine, toolCenter,
    accountManager,
    getAccountGit: (id: string): ITradingGit | undefined => accountSetups.get(id)?.setup.git,
    reconnectAccount,
    reconnectConnectors,
  }

  for (const plugin of [...corePlugins, ...optionalPlugins.values()]) {
    await plugin.start(ctx)
    console.log(`plugin started: ${plugin.name}`)
  }

  console.log('engine: started')

  // ==================== CCXT Background Injection ====================
  // When the CCXT account is ready, wire up TradingGit + register tools so the next
  // agent call picks them up automatically (VercelAIProvider re-checks tool count).

  // When CCXT finishes async init, just register it with AccountManager.
  // Trading tools already exist and will discover accounts dynamically via source routing.
  ccxtInitPromise.then(async (readyAccount) => {
    if (!readyAccount) return
    const savedState = await loadGitState(CRYPTO_GIT_FILE)
    const setup = wireAccountTrading(readyAccount, {
      guards: config.crypto.guards,
      savedState,
      onCommit: createGitPersister(CRYPTO_GIT_FILE),
    })
    accountManager.addAccount(readyAccount)
    accountSetups.set(readyAccount.id, { setup, gitFilePath: CRYPTO_GIT_FILE })
    console.log(`ccxt: ${readyAccount.label} online`)
  })

  // ==================== Shutdown ====================

  let stopped = false
  const shutdown = async () => {
    stopped = true
    newsCollector?.stop()
    heartbeat.stop()
    cronListener.stop()
    cronEngine.stop()
    for (const plugin of [...corePlugins, ...optionalPlugins.values()]) {
      await plugin.stop()
    }
    await newsStore.close()
    await eventLog.close()
    await accountManager.closeAll()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // ==================== Tick Loop ====================

  while (!stopped) {
    await sleep(config.engine.interval)
  }
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
