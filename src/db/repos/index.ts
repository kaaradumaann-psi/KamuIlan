/**
 * Depo konteyneri — tüm koleksiyon erişimi buradan yapılır.
 */
import type { Clock } from '../../lib/clock';
import { systemClock } from '../../lib/clock';
import { getStore } from '../store';
import type { StoragePort } from '../ports';
import { JobRepo } from './jobs';
import { NotificationRepo } from './notifications';
import { OutboxRepo } from './outbox';
import { ReviewRepo } from './review';
import { ScrapeRunRepo } from './runs';
import { SourceRepo } from './sources';
import { TelegramRepo } from './telegram';
import {
  AuditRepo,
  BuiltinQueueRepo,
  HeartbeatRepo,
  LockRepo,
  RateLimitRepo,
  SavedJobRepo,
  ScheduledTaskRepo,
} from './system';
import { UserRepo } from './users';

export interface Repos {
  store: StoragePort;
  clock: Clock;
  sources: SourceRepo;
  jobs: JobRepo;
  users: UserRepo;
  notifications: NotificationRepo;
  outbox: OutboxRepo;
  runs: ScrapeRunRepo;
  review: ReviewRepo;
  locks: LockRepo;
  rateLimits: RateLimitRepo;
  scheduledTasks: ScheduledTaskRepo;
  queue: BuiltinQueueRepo;
  heartbeats: HeartbeatRepo;
  audit: AuditRepo;
  savedJobs: SavedJobRepo;
  telegram: TelegramRepo;
}

export function createRepos(store: StoragePort, clock: Clock = systemClock): Repos {
  return {
    store,
    clock,
    sources: new SourceRepo(store, clock),
    jobs: new JobRepo(store, clock),
    users: new UserRepo(store, clock),
    notifications: new NotificationRepo(store, clock),
    outbox: new OutboxRepo(store, clock),
    runs: new ScrapeRunRepo(store, clock),
    review: new ReviewRepo(store, clock),
    locks: new LockRepo(store, clock),
    rateLimits: new RateLimitRepo(store, clock),
    scheduledTasks: new ScheduledTaskRepo(store, clock),
    queue: new BuiltinQueueRepo(store, clock),
    heartbeats: new HeartbeatRepo(store, clock),
    audit: new AuditRepo(store, clock),
    savedJobs: new SavedJobRepo(store, clock),
    telegram: new TelegramRepo(store, clock),
  };
}

let singleton: Repos | null = null;

export function getRepos(): Repos {
  if (!singleton) singleton = createRepos(getStore());
  return singleton;
}

export function setRepos(repos: Repos | null): void {
  singleton = repos;
}

export { JobRepo, NotificationRepo, OutboxRepo, ReviewRepo, ScrapeRunRepo, SourceRepo, TelegramRepo, UserRepo };
export * from './system';
