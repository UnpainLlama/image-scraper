export type JobMode = "exact" | "crawl";
export type JobStatus = "initializing" | "running" | "paused" | "budget-paused" | "completed" | "cancelled" | "verified" | "abandoned" | "clearing" | "clearing_failed";
export interface JobSettings {
  allowedOrigin: string;
  mode: JobMode;
  concurrency: number;
  maxDepth: number;
  maxPages: number;
  maxFileBytes: number;
  budgetBytes: number;
  perDomainDelayMs: number;
  maxImagesPerPage?: number;
  maxImagesPerJob?: number;
  eliteBabesMode?: "images" | "galleries";
  followNextPage?: boolean;
}
export interface QueuePayload { jobId: string; taskId: string; }
export interface StoredTaskPayload { url: string; depth?: number; }
export interface BrowserRunBinding {
  quickAction(action: "content", options: {
    url: string;
    allowRequestPattern?: string[];
    rejectRequestPattern?: string[];
    gotoOptions?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2"; timeout?: number };
  }): Promise<Response>;
}
export interface Env {
  ASSETS: Fetcher;
  JOBS: DurableObjectNamespace;
  IMAGES: R2Bucket;
  DISCOVERY_QUEUE: Queue<QueuePayload>;
  DOWNLOAD_QUEUE: Queue<QueuePayload>;
  BROWSER: BrowserRunBinding;
  APP_PASSWORD?: string;
  SESSION_SECRET?: string;
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
  lastActivityAt?: number;
  abandonedAt?: number | null;
  cleanupAt?: number | null;
  taskCounts?: { pending: number; leased: number; done: number; failed: number };
  activePermits?: number;
}
export interface FetchResult { response: Response; finalUrl: URL; permitId: string; release: () => Promise<void>; }
export interface ImageCandidate { url: string; }
export interface DiscoveryResult {
  images: ImageCandidate[];
  stylesheets: string[];
  pages: string[];
  /** True when pages are bounded site-adapter continuations (albums or pagination). */
  followPages?: boolean;
}
export interface ImageFormat { extension: string; contentType: string; }
