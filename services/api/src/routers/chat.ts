import express, { Request, Response } from "express";
import Langfuse from "langfuse";
import { uuid } from "uuidv4";
import { integrationModel, PlanFieldCode } from "@merlinn/db";
import { IIntegration } from "@merlinn/db";
import { runAgent } from "../agent";
import { getSlackUser } from "../middlewares/slack";
import { parseMessages } from "../agent/parse";
import { RunContext, TextBlock } from "../agent/types";
import { conversationTemplate } from "../agent/prompts";
import { chatModel, visionModel } from "../agent/model";
import { generateTrace, runModel } from "../agent/helper";
import { AppError, ErrorCode } from "../errors";
import { EventType, SystemEvent, events } from "../events";
import { catchAsync } from "../utils/errors";
import { isEnterprise, isLangfuseEnabled } from "../utils/ee";
// import { validateModeration } from "../utils/moderation";
import { getPlanFieldState, incrementPlanFieldState } from "../services/plans";
import { checkAuth, getDBUser } from "../middlewares/auth";
import { PostHogClient } from "../telemetry/posthog";

const router = express.Router();

const getCompletions = async (req: Request, res: Response) => {
  if (!req.user) {
    throw AppError({
      message: "No internal user",
      statusCode: 403,
      internalCode: ErrorCode.NO_INTERNAL_USER,
    });
  } else if (req.user.status === "invited") {
    throw AppError({
      message: "User hasn't accepted the invitation yet",
      statusCode: 403,
      internalCode: ErrorCode.INVITATION_NOT_ACCEPTED,
    });
  }

  if (isEnterprise()) {
    const queriesState = await getPlanFieldState({
      fieldCode: PlanFieldCode.queries,
      organizationId: String(req.user!.organization._id),
      userId: String(req.user!._id),
    });
    if (!queriesState.isAllowed) {
      throw AppError({
        message: `You have exceeded your queries' quota`,
        statusCode: 429,
        internalCode: ErrorCode.QUOTA_EXCEEDED,
      });
    }

    // Update quota
    await incrementPlanFieldState({
      fieldCode: PlanFieldCode.queries,
      organizationId: String(req.user!.organization._id),
      userId: String(req.user!._id),
    });
  }

  const { messages, metadata: requestMetadata = {} } = req.body;
  const email = req.headers["x-slack-email"] as string;

  const organizationName = req.user.organization.name;
  const organizationId = String(req.user.organization._id);
  const integrations = (await integrationModel
    .get({
      organization: organizationId,
    })
    .populate("vendor")) as IIntegration[];
  if (!integrations.length) {
    throw AppError({
      message: "No integrations at all",
      statusCode: 404,
      internalCode: ErrorCode.NO_INTEGRATION,
    });
  }

  let output: string | null = null;
  let traceId = "";
  let traceURL = "";
  let observationId = "";
  const chatMessages = parseMessages(messages);
  const message = chatMessages[chatMessages.length - 1];

  // const moderationResult = await validateModeration(message.content as string);

  // if (!moderationResult) {
  //   throw AppError({ message:
  //     "Text was found that violates our content policy",
  //     400,
  //     ErrorCode.MODERATION_FAILED,
  //   );
  // }

  const hasImages =
    typeof message.content !== "string" &&
    message.content.some((item) => item.type === "image_url");

  const runContext: RunContext = {
    email,
    env: process.env.NODE_ENV as string,
    userId: String(req.user._id),
    organizationName: req.user.organization.name,
    organizationId: String(req.user.organization._id),
    context: "chat",
  };
  // Create trace
  if (isLangfuseEnabled()) {
    const trace = generateTrace({ ...runContext });
    runContext.trace = trace;
  }

  if (requestMetadata.eventId) {
    runContext.eventId = requestMetadata.eventId;
  }

  if (!hasImages) {
    // Remove the last item
    chatMessages.pop();

    const prompt =
      typeof message.content === "string"
        ? message.content
        : (message.content[0] as TextBlock).text;

    try {
      const { answer, answerContext } = await runAgent({
        prompt,
        model: chatModel,
        template: conversationTemplate,
        integrations,
        messages: chatMessages,
        context: runContext,
      });

      output = answer;
      traceId = answerContext.getTraceId()!;
      observationId = answerContext.getObservationId()!;
      traceURL = answerContext.getTraceURL()!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      console.error(error);
      throw AppError({
        message: error.message,
        statusCode: 500,
        internalCode: ErrorCode.AGENT_RUN_FAILED,
        stack: error.stack,
      });
    }
  } else {
    try {
      const result = await runModel({
        model: visionModel,
        template: conversationTemplate,
        context: runContext,
        messages: chatMessages,
      });
      output = result.output;
      traceId = result.traceId!;
      observationId = result.observationId!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      throw AppError({
        message: error.message,
        statusCode: 500,
        internalCode: ErrorCode.MODEL_RUN_FAILED,
      });
    }
  }

  const event: SystemEvent = {
    type: EventType.answer_created,
    entityId: String(req.user._id),
    payload: {
      organizationId,
      env: process.env.NODE_ENV as string,
      email: req.user.email,
      context: "chat",
      traceId,
      traceURL,
      observationId,
      organizationName,
    },
  };
  if (!isLangfuseEnabled()) {
    event.payload.text = output;
    event.payload.prompt = message.content as string;
  }
  events.publish(event);

  return res.status(200).json({ output, traceURL, traceId, observationId });
};

/** This endpoint is called by our Slack application
 * It provides the app token as the authentication means, instead of Ory session token
 * TODO: figure out if we can generate a token from the slack app on the fly.
 */
router.post(
  "/completions/slack",
  getSlackUser,
  catchAsync(async (req: Request, res: Response) => {
    return getCompletions(req, res);
  }),
);

router.post(
  "/completions/general",
  checkAuth,
  getDBUser,
  catchAsync(async (req: Request, res: Response) => {
    return getCompletions(req, res);
  }),
);

router.post(
  "/feedback",
  catchAsync(async (req: Request, res: Response) => {
    if (!isLangfuseEnabled()) {
      return res.status(500).json({ message: "Langfuse is not enabled" });
    }

    const { traceId, observationId, value, text } = req.body;
    if (isLangfuseEnabled()) {
      if (!traceId || !observationId || !value) {
        throw AppError({
          message:
            "Bad request. Need to supply traceId, observationId and value",
          statusCode: 400,
        });
      }
      const langfuse = new Langfuse({
        secretKey: process.env.LANGFUSE_SECRET_KEY as string,
        publicKey: process.env.LANGFUSE_PUBLIC_KEY as string,
        baseUrl: process.env.LANGFUSE_HOST as string,
      });
      await langfuse.score({
        name: "user-feedback",
        traceId,
        observationId,
        value,
      });
    } else {
      const posthog = new PostHogClient();
      posthog.capture({
        event: "feedback_received",
        distinctId: uuid(),
        properties: {
          value,
          text,
        },
      });
    }
    return res.status(200).json({ message: "Feedback has been received" });
  }),
);

export { router };
