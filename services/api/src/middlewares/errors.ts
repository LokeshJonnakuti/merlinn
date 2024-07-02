import { Request, Response, NextFunction } from "express";
import { AppError } from "../errors";
import { PostHogClient } from "../telemetry/posthog";
import { uuid } from "uuidv4";
// handles productional error

const captureErrorInTelemetry = (error: AppError) => {
  const posthog = new PostHogClient();
  posthog.capture({
    event: "app_error",
    distinctId: uuid(),
    properties: {
      message: error.message,
    },
  });
};
const productionError = (error: AppError, res: Response) => {

  captureErrorInTelemetry(error);

  // Send a lean error message
  res.status(error.statusCode).json({
    status: error.status,
    message: error.message,
    code: error.internalCode,
  });
};

// Send a detailed error message, for debugging purposes
const developmentError = (error: AppError, res: Response) => {
  console.error("developmentError error: ", error);

  captureErrorInTelemetry(error);

  res.status(error.statusCode).json({
    status: error.status,
    message: error.message,
    code: error.internalCode,
    error: error,
    stack: error.stack,
  });
};

export const errorHandler = (
  error: AppError,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
) => {
  if (process.env.NODE_ENV === "development") {
    developmentError(error, res);
  } else if (process.env.NODE_ENV === "production") {
    // TODO: we should use a logger here
    console.log("\n\n------ begin: ------");
    console.log("ERROR: ", error);
    console.log("------ end: ------\n\n");
    productionError(error, res);
  }
};

export const invalidPathHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const error = new AppError(
    `Path ${req.originalUrl} does not exist for ${req.method} method`,
    404,
  );
  next(error);
};
