import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventBus } from './events/event-bus.js';
import { EventStore } from './events/event-store.js';
import type { EmitEventFn, ProjectEvent } from './events/types.js';
import { ApiServer } from './api/server.js';
import { FileWatcher } from './observers/file-watcher.js';
import { GitObserver } from './observers/git-observer.js';
import { ReasoningRouter } from './reasoning/router.js';
import { LocalLlmProvider } from './reasoning/local-llm.js';
import { CliAgentProvider } from './reasoning/cli-agent.js';
import { SnapshotEngine } from './state/snapshot-engine.js';
import { DialogHandler } from './dialog/dialog-handler.js';
import { SuggestionEngine } from './suggestions/suggestion-engine.js';
import { ConfidenceCalibrator } from './trust/confidence-calibrator.js';
import { DampingController } from './trust/damping.js';
import { FeedbackTracker } from './trust/feedback-tracker.js';
import { MetricsCollector } from './telemetry/metrics-collector.js';
import { AuditLog } from './telemetry/audit-log.js';
import { initialScan } from './observers/initial-scanner.js';
import { DesignTaskManager } from './design-iteration/design-task-manager.js';
import { DesignPipeline } from './design-iteration/design-pipeline.js';
import { InitiativeManager } from './initiatives/manager.js';
import { RetrospectiveEngine } from './retrospectives/engine.js';
import type { Observer } from './observers/types.js';
import type { ProviderName } from './reasoning/types.js';

export interface DaemonOptions {
  projectDir: string;
  port: number;
}

const PROJECT_ID = 'default';

// Event types grouped by which manager owns them — used to filter the replay
// stream so each manager sees only its own events.
const SUGGESTION_EVENT_TYPES = ['suggestion_created', 'suggestion_status_changed'];
const TASK_EVENT_TYPES = [
  'task_created',
  'task_status_changed',
  'task_pipeline_updated',
  'task_change_level_updated',
];
const DESIGN_EVENT_TYPES = [
  'design_task_created',
  'design_variant_added',
  'design_renders_complete',
  'design_ai_scored',
  'design_human_reviewed',
  'design_constraint_learned',
  'design_awaiting_review',
  'design_round_started',
  'design_round_converged',
  'design_task_completed',
];
const INITIATIVE_EVENT_TYPES = [
  'initiative_created',
  'initiative_updated',
  'initiative_note_added',
  'initiative_completed',
  'initiative_abandoned',
];
const RETROSPECTIVE_EVENT_TYPES = ['retrospective_generated'];

const DEFAULT_RETROSPECTIVE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

  // Managers (event-sourced)
  private suggestionEngine: SuggestionEngine;
  private designTaskManager: DesignTaskManager;
  private designPipeline: DesignPipeline;
  private initiativeManager: InitiativeManager;
  private retrospectiveEngine: RetrospectiveEngine;
  private retrospectiveTimer: NodeJS.Timeout | null = null;
  private retrospectiveIntervalMs: number = DEFAULT_RETROSPECTIVE_INTERVAL_MS;

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

    const emit: EmitEventFn = (event) => this.appendAndPublish(event);

    // ── L3: Reasoning Router ──
    this.router = new ReasoningRouter();

    // ── L2: State ──
    this.snapshotEngine = new SnapshotEngine(PROJECT_ID, this.eventStore, this.eventBus);

    // ── Managers (event-sourced) ──
    this.suggestionEngine = new SuggestionEngine({ projectId: PROJECT_ID, emit });
    this.designTaskManager = new DesignTaskManager({ projectId: PROJECT_ID, emit });
    this.designPipeline = new DesignPipeline({ taskManager: this.designTaskManager });
    this.initiativeManager = new InitiativeManager({ projectId: PROJECT_ID, emit });
    this.retrospectiveEngine = new RetrospectiveEngine({
      projectId: PROJECT_ID,
      eventStore: this.eventStore,
      initiativeManager: this.initiativeManager,
      emit,
    });

    // Pick up override from .agentos/config.json if present.
    try {
      const cfgRaw = fs.readFileSync(path.join(this.agentosDir, 'config.json'), 'utf-8');
      const cfg = JSON.parse(cfgRaw) as { retrospective?: { intervalMs?: number } };
      if (typeof cfg.retrospective?.intervalMs === 'number' && cfg.retrospective.intervalMs > 0) {
        this.retrospectiveIntervalMs = cfg.retrospective.intervalMs;
      }
    } catch { /* no override */ }

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
      designTaskManager: this.designTaskManager,
      designPipeline: this.designPipeline,
      initiativeManager: this.initiativeManager,
      retrospectiveEngine: this.retrospectiveEngine,
      metricsCollector: this.metricsCollector,
      auditLog: this.auditLog,
      configPath: path.join(this.agentosDir, 'config.json'),
    });
  }

  /**
   * The single event-ingress point.
   * Persists the event to the store (stamping id + timestamp) and publishes
   * the fully-populated event to the in-process bus.
   */
  appendAndPublish(event: Omit<ProjectEvent, 'id' | 'timestamp'>): ProjectEvent {
    const full = this.eventStore.append(event);
    this.eventBus.publish(full);
    return full;
  }

  async start(): Promise<void> {
    // ── Initialize stores ──
    await this.eventStore.ensureReady();

    // ── Initial scan (first start only — populates existing files + git history) ──
    const scanned = await initialScan(this.opts.projectDir, this.eventStore, PROJECT_ID);
    if (scanned > 0) {
      this.auditLog.record({ actor: 'system', action: 'initial_scan', target: `${scanned} items` });
    }

    // ── Replay managers from persisted events ──
    this.replayManagers();

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

    // ── Schedule periodic retrospective generation ──
    this.startRetrospectiveScheduler();

    // ── PID file ──
    fs.writeFileSync(path.join(this.agentosDir, 'daemon.pid'), String(process.pid));

    this.auditLog.record({ actor: 'system', action: 'daemon_started', target: this.opts.projectDir });
  }

  async stop(): Promise<void> {
    if (this.retrospectiveTimer) {
      clearInterval(this.retrospectiveTimer);
      this.retrospectiveTimer = null;
    }
    for (const obs of this.observers) {
      await obs.stop();
    }
    this.snapshotEngine.stop();
    await this.apiServer.stop();
    this.eventStore.close();

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
  getDesignTaskManager(): DesignTaskManager { return this.designTaskManager; }
  getDesignPipeline(): DesignPipeline { return this.designPipeline; }
  getMetricsCollector(): MetricsCollector { return this.metricsCollector; }
  getAuditLog(): AuditLog { return this.auditLog; }
  getFeedbackTracker(): FeedbackTracker { return this.feedbackTracker; }
  getConfidenceCalibrator(): ConfidenceCalibrator { return this.confidenceCalibrator; }
  getDampingController(): DampingController { return this.dampingController; }
  getInitiativeManager(): InitiativeManager { return this.initiativeManager; }
  getRetrospectiveEngine(): RetrospectiveEngine { return this.retrospectiveEngine; }

  // ── Private setup methods ──

  private replayManagers(): void {
    // Load all past events once, then slice per manager — avoids N round-trips.
    const allEvents = this.eventStore.query({ projectId: PROJECT_ID });

    this.suggestionEngine.replay(allEvents.filter((e) => SUGGESTION_EVENT_TYPES.includes(e.type)));
    this.designTaskManager.replay(allEvents.filter((e) => DESIGN_EVENT_TYPES.includes(e.type)));
    this.initiativeManager.replay(allEvents.filter((e) => INITIATIVE_EVENT_TYPES.includes(e.type)));
    this.retrospectiveEngine.replay(allEvents.filter((e) => RETROSPECTIVE_EVENT_TYPES.includes(e.type)));
    // Replay the TaskManager once it owns a CodeTask pipeline instance wired via
    // the ReviewPipeline integration path.
    void TASK_EVENT_TYPES;
  }

  private startRetrospectiveScheduler(): void {
    if (this.retrospectiveIntervalMs <= 0) return;
    this.retrospectiveTimer = setInterval(() => {
      try {
        this.retrospectiveEngine.generate({ windowMs: this.retrospectiveIntervalMs });
      } catch (err) {
        this.auditLog.record({
          actor: 'system',
          action: 'retrospective_failed',
          target: err instanceof Error ? err.message : String(err),
        });
      }
    }, this.retrospectiveIntervalMs);
    // Don't let this timer keep the process alive on its own.
    this.retrospectiveTimer.unref?.();
  }

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
    const publishEvent: EmitEventFn = (event) => this.appendAndPublish(event);

    const fw = new FileWatcher({
      projectDir: this.opts.projectDir,
      projectId: PROJECT_ID,
      publishEvent,
    });
    fw.start();
    this.observers.push(fw);

    const go = new GitObserver({
      projectDir: this.opts.projectDir,
      projectId: PROJECT_ID,
      publishEvent,
    });
    go.start();
    this.observers.push(go);
  }

  private wireEventHandlers(): void {
    // Track git commits for flow detection (damping)
    this.eventBus.subscribe((event) => {
      if (event.type === 'commit_pushed') {
        this.dampingController.recordCommit();
      }
    });

    // Trust feedback loop: rejected suggestions → FeedbackTracker + calibrator.
    this.eventBus.subscribe((event) => {
      if (event.type !== 'suggestion_status_changed') return;
      const id = event.payload.id as string | undefined;
      const status = event.payload.status as string | undefined;
      if (!id || !status) return;
      const suggestion = this.suggestionEngine.get(id);
      if (!suggestion) return;
      if (status === 'rejected') {
        this.feedbackTracker.record({
          type: 'suggestion_rejected',
          source_id: id,
          category: suggestion.category,
          user_action: 'reject',
        });
        this.confidenceCalibrator.record(suggestion.category, false);
      } else if (status === 'accepted' || status === 'converted') {
        this.confidenceCalibrator.record(suggestion.category, true);
      }
    });

    // Auto-generate suggestions from significant events.
    this.eventBus.subscribe((event) => {
      this.tryGenerateSuggestion(event);
    });
  }

  /**
   * Analyze events and auto-generate suggestions when patterns are detected.
   */
  private tryGenerateSuggestion(event: ProjectEvent): void {
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
