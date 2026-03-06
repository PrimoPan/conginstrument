import type { NextFunction, Request, RequestHandler, Response } from "express";

export function asyncRoute<TReq extends Request = Request, TRes extends Response = Response>(
  handler: (req: TReq, res: TRes, next: NextFunction) => Promise<unknown> | unknown
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req as TReq, res as TRes, next)).catch(next);
  };
}
