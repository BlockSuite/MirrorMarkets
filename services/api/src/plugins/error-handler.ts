import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { AppError, ErrorCodes } from '@mirrormarkets/shared';
import { ZodError } from 'zod';

const errorHandlerImpl: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(error.toJSON());
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Validation failed',
        details: { issues: error.issues },
      });
    }

    // Fastify rate limit error
    if (error.statusCode === 429) {
      return reply.status(429).send({
        code: ErrorCodes.RATE_LIMITED,
        message: 'Too many requests',
      });
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    request.log.error({ err: error }, `Unhandled error: ${errorMessage}`);
    if (errorStack) request.log.error(errorStack);

    return reply.status(500).send({
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Internal server error',
    });
  });
};

export const errorHandler = fp(errorHandlerImpl, { name: 'error-handler' });
