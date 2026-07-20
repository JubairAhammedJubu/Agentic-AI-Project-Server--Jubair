import {WithId, Document} from "mongodb";

declare global {
  namespace Express {
    interface Request {
      user?: WithId<Document>;
    }
  }
}

export {};
