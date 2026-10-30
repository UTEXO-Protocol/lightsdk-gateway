/**
 * Fastify JSON schemas for every gateway route. Response schemas are strict
 * (additionalProperties: false) so serialization strips anything undeclared —
 * a structural backstop for invariants I1/I4.
 */

export const errorBodySchema = {
  type: 'object',
  description:
    'Every error the gateway raises. Clients branch on `code`; `message` is for humans and may change.',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Stable, machine-readable error code.' },
        message: { type: 'string', description: 'Human-readable explanation.' },
      },
      required: ['code', 'message'],
      additionalProperties: false,
    },
  },
  required: ['error'],
  additionalProperties: false,
} as const;

export const healthRouteSchema = {
  response: {
    200: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['ok'] } },
      required: ['status'],
      additionalProperties: false,
    },
  },
} as const;

/**
 * Bootstrap-only user creation, guarded by the operator token. The bearer
 * token is returned exactly once here and stored only as a hash.
 */
export const createUserRouteSchema = {
  headers: {
    type: 'object',
    properties: { 'x-operator-token': { type: 'string' } },
  },
  response: {
    201: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Opaque user id (`u_` and 32 hex characters).' },
        token: {
          type: 'string',
          description:
            "The user's bearer token. Returned only here: the gateway stores just its hash.",
        },
        createdAt: { type: 'integer', description: 'Unix milliseconds.' },
      },
      required: ['userId', 'token', 'createdAt'],
      additionalProperties: false,
    },
    400: errorBodySchema,
    401: errorBodySchema,
  },
} as const;

export const meRouteSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        createdAt: { type: 'integer', description: 'Unix milliseconds.' },
      },
      required: ['userId', 'createdAt'],
      additionalProperties: false,
    },
    401: errorBodySchema,
  },
} as const;
