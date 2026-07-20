import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminCapability } from '../admin-auth.js';
import { conflict } from '../errors.js';
import {
  listServiceConfigurations,
  deleteServiceConfiguration,
  serviceConfigurationDefinitions,
  ServiceConfigurationVersionError,
  validateServiceConfigurationValue,
  writeServiceConfiguration,
  type ServiceConfigurationKey,
} from '../services/service-configuration.js';

const reasonSchema = z.string().trim().min(3).max(500);
const keys = Object.keys(serviceConfigurationDefinitions) as [ServiceConfigurationKey, ...ServiceConfigurationKey[]];

export async function registerAdminServiceConfigurationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/admin/service-configurations', {
    preHandler: async (request, reply) => {
      await requireAdminCapability(request, reply, 'MANAGE_SETTINGS');
      reply.header('Cache-Control', 'private, no-store');
    },
  }, async () => ({ ok: true, data: { items: await listServiceConfigurations() } }));

  app.patch('/v1/admin/service-configurations/:key', {
    preHandler: async (request, reply) => {
      await requireAdminCapability(request, reply, 'MANAGE_SETTINGS');
      reply.header('Cache-Control', 'private, no-store');
    },
  }, async (request) => {
    const { key } = z.object({ key: z.enum(keys) }).parse(request.params);
    const body = z.object({
      value: z.unknown(),
      expectedVersion: z.number().int().min(0),
      reason: reasonSchema,
    }).parse(request.body);
    const value = validateServiceConfigurationValue(key, body.value);
    let updated: { version: number; updatedAt: Date };
    try {
      updated = await writeServiceConfiguration(
        key,
        value,
        body.expectedVersion,
        request.auth.subjectId,
        {
          reason: body.reason,
          requestId: request.id,
          ipAddress: request.ip.slice(0, 200),
        },
      );
    } catch (error) {
      if (error instanceof ServiceConfigurationVersionError) {
        throw conflict('SERVICE_CONFIGURATION_VERSION_CHANGED', '配置已被其他管理员修改，请刷新');
      }
      throw error;
    }
    const item = (await listServiceConfigurations()).find((candidate) => candidate.key === key);
    return { ok: true, data: item };
  });

  app.delete('/v1/admin/service-configurations/:key', {
    preHandler: async (request, reply) => {
      await requireAdminCapability(request, reply, 'MANAGE_SETTINGS');
      reply.header('Cache-Control', 'private, no-store');
    },
  }, async (request) => {
    const { key } = z.object({ key: z.enum(keys) }).parse(request.params);
    const body = z.object({
      expectedVersion: z.number().int().positive(),
      reason: reasonSchema,
    }).parse(request.body);
    try {
      await deleteServiceConfiguration(
        key,
        body.expectedVersion,
        request.auth.subjectId,
        {
          reason: body.reason,
          requestId: request.id,
          ipAddress: request.ip.slice(0, 200),
        },
      );
    } catch (error) {
      if (error instanceof ServiceConfigurationVersionError) {
        throw conflict('SERVICE_CONFIGURATION_VERSION_CHANGED', '配置已被其他管理员修改，请刷新');
      }
      throw error;
    }
    const item = (await listServiceConfigurations()).find((candidate) => candidate.key === key);
    return { ok: true, data: item };
  });
}
