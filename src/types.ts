export type JobMode = "exact" | "crawl";
export type JobStatus = "initializing" | "running" | "paused" | "budget-paused" | "completed" | "cancelled" | "clearing";

export interface JobSettings {
  allowedOrigin: string;
  mode: JobMode;
  concurrency: number;
  maxDepth: number;
  maxPages: number;
  maxFileBytes: number;
  budgetBytes: number;
  perDomainDelayMs: number;
}

export interface DiscoveryMessage {
  jobId: string;
  pageUrl: string;
  depth: number;
  taskId: string;
}

export interface DownloadMessage {
  jobId: string;
  imageUrl: string;
  sourcePage: string;
  taskId: string;
}

export type QueuePayload = DiscoveryMessage | DownloadMessage;

export interface BrowserRunBinding {
  quickAction(action: "content", options: { url: string }): Promise<Response>;
}

export interface Env {
  ASSETS: Fetcher;
  JOBS: DurableObjectNamespace;
  IMAGES: R2Bucket;
  DISCOVERY_QUEUE: Queue<DiscoveryMessage>;
  DOWNLOAD_QUEUE: Queue<DownloadMessage>;
  BROWSER: BrowserRunBinding;
}

export interface JobSnapshot {
  jobId: string;
  status: JobStatus;
  createdAt: number;
  pagesDiscovered: number;
  pagesCompleted: number;
  pendingPages: number;
  imagesDiscovered: number;
  imagesDownloaded: number;
  imagesStored: number;
  failedImages: number;
  pendingImages: number;
  bytesStored: number;
  bytesReserved: number;
  budgetBytes: number;
  concurrency: number;
  verified: boolean;
  failedByCode: Array<{ code: string; count: number }>;
}

export interface FetchResult {
  response: Response;
  finalUrl: URL;
  permitId: string;
  release: () => Promise<void>;
}

export interface RobotsPolicy {
  rules: Array<{ allow: boolean; path: string }>;
  crawlDelayMs: number;
}

export interface ImageCandidate {
  url: string;
  source: string;
}

export interface DiscoveryResult {
  images: ImageCandidate[];
  stylesheets: string[];
  pages: string[];
}

export interface ImageFormat {
  extension: string;
  contentType: string;
}