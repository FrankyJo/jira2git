import type { ReportGenerator } from '../ai/types';
import type { AdfRenderer } from '../adf/types';
import type { GitRefs } from '../checkpoints/refs';
import type { LineageStore } from '../checkpoints/store';
import type { BaseBranchResolver } from '../git/base';
import type { ConfigStore } from '../config/store';
import type { PathEnvironment } from '../config/paths';
import type { CredentialStore } from '../credentials/types';
import type { DiagnosticsRunner } from '../diagnostics/types';
import type { GitCommandRunner, GitRepositoryLocator, IssueKeyDetector } from '../git/types';
import type { Prompter } from '../installer/prompter';
import type { JiraAuthProvider } from '../jira/auth/types';
import type { JiraClient } from '../jira/client/types';
import type { LabelCatalog } from '../localization/catalog';
import type { PublicationLifecycle } from '../publication/lifecycle';
import type { PublicationService } from '../publication/types';
import type { SkillInstaller } from '../skill/types';
import type { IncrementalDiffEngine, SnapshotEngine } from '../snapshots/types';
import { NotImplementedError } from '../core/errors';
import type { Phase } from '../core/phases';

/** Every service the application composes, keyed by name. */
export interface ServiceRegistry {
  pathEnvironment: PathEnvironment;
  configStore: ConfigStore;
  prompter: Prompter;
  gitRunner: GitCommandRunner;
  repositoryLocator: GitRepositoryLocator;
  issueKeyDetector: IssueKeyDetector;
  baseResolver: BaseBranchResolver;
  snapshotEngine: SnapshotEngine;
  diffEngine: IncrementalDiffEngine;
  lineageStore: LineageStore;
  gitRefs: GitRefs;
  publicationLifecycle: PublicationLifecycle;
  credentialStore: CredentialStore;
  jiraAuth: JiraAuthProvider;
  jiraClient: JiraClient;
  reportGenerator: ReportGenerator;
  labelCatalog: LabelCatalog;
  adfRenderer: AdfRenderer;
  publicationService: PublicationService;
  skillInstaller: SkillInstaller;
  diagnostics: DiagnosticsRunner;
}

export type ServiceName = keyof ServiceRegistry;

/** Phase that delivers each service; used to explain unregistered services honestly. */
export const SERVICE_PHASES: Readonly<Record<ServiceName, Phase>> = {
  pathEnvironment: 0,
  configStore: 0,
  prompter: 5,
  gitRunner: 1,
  repositoryLocator: 1,
  issueKeyDetector: 1,
  baseResolver: 1,
  snapshotEngine: 1,
  diffEngine: 1,
  lineageStore: 1,
  gitRefs: 1,
  publicationLifecycle: 1,
  credentialStore: 2,
  jiraAuth: 2,
  jiraClient: 2,
  adfRenderer: 2,
  publicationService: 2,
  reportGenerator: 3,
  labelCatalog: 3,
  skillInstaller: 4,
  diagnostics: 5,
};

type Factory<K extends ServiceName> = (container: ServiceContainer) => ServiceRegistry[K];

/**
 * Small typed dependency-injection container. Services are registered as
 * factories and created lazily once. Resolving a service that no phase has
 * registered yet throws NotImplementedError instead of returning a stub.
 */
export class ServiceContainer {
  private readonly factories = new Map<ServiceName, Factory<ServiceName>>();
  private readonly instances = new Map<ServiceName, ServiceRegistry[ServiceName]>();

  register<K extends ServiceName>(name: K, factory: Factory<K>): this {
    this.factories.set(name, factory);
    this.instances.delete(name);
    return this;
  }

  has(name: ServiceName): boolean {
    return this.factories.has(name);
  }

  resolve<K extends ServiceName>(name: K): ServiceRegistry[K] {
    if (this.instances.has(name)) return this.instances.get(name) as ServiceRegistry[K];
    const factory = this.factories.get(name);
    if (!factory) throw new NotImplementedError(`The "${name}" service`, SERVICE_PHASES[name]);
    const instance = factory(this) as ServiceRegistry[K];
    this.instances.set(name, instance);
    return instance;
  }
}
