export {};

declare module "node:worker_threads" {
  interface WorkerOptions {
    type?: "module" | "commonjs";
  }
}
