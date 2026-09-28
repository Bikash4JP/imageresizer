declare global {
  namespace Express {
    interface Request {
      /** Private per-request scratch directory, deleted when the response closes. */
      workspace?: string;
    }
  }
}

export {};
