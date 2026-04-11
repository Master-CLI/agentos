import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventBus } from './events/event-bus.js';
import { EventStore } from './events/event-store.js';
import { ApiServer } from './api/server.js';
import { FileWatcher } from './observers/file-watcher.js';
import { GitObserver } from './observers/git-observer.js';
import { ReasoningRouter } from './reasoning/router.js';
import { LocalLlmProvider } from './reasoning/local-llm.js';
import { CliAgentProvider } from './reasoning/cli-agent.js';
import { SnapshotEngine } from './state/snapshot-engine.js';
import { detectModules } from './state/module-detector.js';
import { DialogHandler } from './dialog/dialog-handler.js';
import { SuggestionEngine } from './suggestions/suggestion-engine.js';
import { ConfidenceCalibrator } from './trust/confidence-calibrator.js';
import { DampingController } from './trust/damping.js';
import { FeedbackTracker } from './trust/feedback-tracker.js';
import { MetricsCollector } from './telemetry/metrics-collector.js';
import { AuditLog } from './telemetry/audit-log.js';
import type { Observer } from './observers/types.js';
import type { ProviderName } from './reasoning/types.js';

export interface DaemonOptions {
  projectDir: string;
  port: number;
}

export class Daemon {
  // Core
  private eventBus: EventBus;
  private eventStore: EventStore;
  private apiServer: ApiServer;
  private agentosDir: string;

  // Observers
  private observers: Observer[] = [];

  // Reasoning
  private router: ReasoningRouter;

  // State
  private snapshotEngine: SnapshotEngine;

  // Dialog
  private dialogHandler: DialogHandler;

  // Suggestions
  private suggestionEngine: SuggestionEngine;

  // Trust
  private confidenceCalibrator: ConfidenceCalibrator;
  private dampingController: DampingController;
  private feedbackTracker: FeedbackTracker;

  // Telemetry
  private metricsCollector: MetricsCollector;
  private auditLog: AuditLog;

  constructor(private opts: DaemonOptions) {
    this.agentosDir = path.join(opts.projectDir, '.agentos');
    if (!fs.existsSync(this.agentosDir)) {
      throw new Error(`.agentos directory not found in ${opts.projectDir}. Run 'agentos init' first.`);
    }

    // ── L1: Events ──
    this.eventBus = new EventBus();
    this.eventStore = new EventStore(path.join(this.agentosDir, 'events.db'));

    // ── L3: Reasoning Router ──
    this.router = new ReasoningRouter();

    // ── L2: State ──
    this.snapshotEngine = new SnapshotEngine('default', this.eventStore, this.eventBus);

    // ── Suggestions ──
    this.suggestionEngine = new SuggestionEngine();

    // ── Trust ──
    this.confidenceCalibrator = new ConfidenceCalibrator();
    this.dampingController = new DampingController();
    this.feedbackTracker = new FeedbackTracker();

    // ── Dialog ──
    this.dialogHandler = new DialogHandler(this.router, this.snapshotEngine, this.eventStore, this.suggestionEngine);

    // ── Telemetry ──
    this.metricsCollector = new MetricsCollector();
    this.auditLog = new AuditLog();

    // ── API Server (with all dependencies injected) ──
    this.apiServer = new ApiServer({
      port: opts.port,
      eventBus: this.eventBus,
      dialogHandler: this.dialogHandler,
      suggestionEngine: this.suggestionEngine,
      metricsCollector: this.metricsCollector,
      auditLog: this.auditLog,
      configPath: path.join(this.agentosDir, 'config.json'),
    });
  }

  appendAndPublish(event: Parameters<EventStore['append']>[0]): void {
    const full = this.eventStore.append(event);
    this.eventBus.publish(full);
  }

  async start(): Promise<void> {
    // ── Initialize stores ──
    await this.eventStore.ensureReady();

    // ── Rebuild snapshot from persisted events ──
    await this.snapshotEngine.rebuild();
    this.snapshotEngine.start();

    // ── Register reasoning providers ──
    await this.registerProviders();

    // ── Start observers ──
    this.startObservers();

    // ── Wire cross-cutting concerns ──
    this.wireEventHandlers();

    // ── Start API server ──
    await this.apiServer.start();

    // ── PID file ──
    fs.writeFileSync(path.join(this.agentosDir, 'daemon.pid'), String(process.pid));

    this.auditLog.record({ actor: 'system', action: 'daemon_started', target: this.opts.projectDir });
  }

  async stop(): Promise<void> {
    // Stop observers
    for (const obs of this.observers) {
      await obs.stop();
    }

    // Stop snapshot engine
    this.snapshotEngine.stop();

    // Stop API server
    await this.apiServer.stop();

    // Close event store
    this.eventStore.close();

    // Remove PID file
    const pidPath = path.join(this.agentosDir, 'daemon.pid');
    if (fs.existsSync(pidPath)) {
      fs.unlinkSync(pidPath);
    }
  }

  get port(): number {
    return this.apiServer.port;
  }

  getEventStore(): EventStore { return this.eventStore; }
  getEventBus(): EventBus { return this.eventBus; }
  getRouter(): ReasoningRouter { return this.router; }
  getSnapshotEngine(): SnapshotEngine { return this.snapshotEngine; }
  getDialogHandler(): DialogHandler { return this.dialogHandler; }
  getSuggestionEngine(): SuggestionEngine { return this.suggestionEngine; }
  getMetricsCollector(): MetricsCollector { return this.metricsCollector; }
  getAuditLog(): AuditLog { return this.auditLog; }

  // ── Private setup methods ──

  private async registerProviders(): Promise<void> {
    // Local LLM (Watchdog)
    const localLlm = new LocalLlmProvider();
    const ollamaOk = await localLlm.checkAvailability();
    this.router.registerProvider(localLlm);
    if (ollamaOk) {
      this.auditLog.record({ actor: 'system', action: 'provider_registered', target: 'local-llm' });
    }

    // CLI Agents
    const cliNames: ProviderName[] = ['claude-code', 'codex', 'gemini'];
    for (const name of cliNames) {
      try {
        const provider = new CliAgentProvider(name);
        await provider.checkAvailability();
        this.router.registerProvider(provider);
        if (provider.available) {
          this.auditLog.record({ actor: 'system', action: 'provider_registered', target: name });
        }
      } catch { /* skip unknown providers */ }
    }
  }

  private startObservers(): void {
    const projectId = 'default';

    // FileWatcher
    const fw = new FileWatcher({
      projectDir: this.opts.projectDir,
      projectId,
      eventBus: this.eventBus,
    });
    fw.start();
    this.observers.push(fw);

    // GitObserver
    const go = new GitObserver({
      projectDir: this.opts.projectDir,
      projectId,
      eventBus: this.eventBus,
    });
    go.start();
    this.observers.push(go);
  }

  private wireEventHandlers(): void {
    // Persist all bus events to store
    this.eventBus.subscribe((event) => {
      if (!event.id) {
        this.eventStore.append(event);
      }
    });

    // Track git commits for flow detection (damping)
    this.eventBus.subscribe((event) => {
      if (event.type === 'commit_pushed') {
        this.dampingController.recordCommit();
      }
    });

    // Auto-generate suggestions from significant events
    this.eventBus.subscribe((event) => {
      this.tryGenerateSuggestion(event);
    });
  }

  /**
   * Analyze events and auto-generate suggestions when patterns are detected.
   */
  private tryGenerateSuggestion(event: import('./events/types.js').ProjectEvent): void {
    // Don't suggest during flow state
    if (this.dampingController.isInFlow()) return;

    const region = typeof event.payload.path === 'string' ? event.payload.path : undefined;
    if (this.dampingController.shouldSuppress(region)) return;

    // Pattern: large file modification (potential risk)
    if (event.type === 'file_modified' && typeof event.payload.size === 'number' && event.payload.size > 50000) {
      this.suggestionEngine.create({
        category: 'architecture',
        summary: `Large file modified: ${String(event.payload.path).split(/[/\\]/).pop()}`,
        detail: `File is ${Math.round(Number(event.payload.size) / 1024)}KB. Consider splitting into smaller modules.`,
        evidence: [event.id ?? event.type],
        confidence: 0.6,
        impact: 'low',
        region,
      });
      this.dampingController.recordSuggestion(region);
    }

    // Pattern: commit with many files changed
    if (event.type === 'commit_pushed' && Array.isArray(event.payload.files_changed) && event.payload.files_changed.length > 10) {
      this.suggestionEngine.create({
        category: 'architecture',
        summary: `Large commit: ${event.payload.files_changed.length} files changed`,
        detail: `Commit "${String(event.payload.message).slice(0, 60)}" touches many files. Consider breaking into smaller commits.`,
        evidence: [event.id ?? event.type],
        confidence: 0.7,
        impact: 'medium',
      });
      this.dampingController.recordSuggestion();
    }
  }
}
