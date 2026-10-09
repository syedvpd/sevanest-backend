import { METHOD_METADATA, PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ModulesContainer } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  ROLES_KEY,
} from '../../src/common/decorators/auth.decorators';
import { USER_TYPES_KEY } from '../../src/common/guards/user-type.guard';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];

export interface Route {
  method: string;
  path: string;
  controller: string;
  handler: string;
  isPublic: boolean;
  userTypes: string[];
  permissions: string[];
  roles: string[];
}

const join = (...parts: Array<string | string[] | undefined>): string =>
  '/' +
  parts
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter((p): p is string => !!p)
    .join('/')
    .split('/')
    .filter(Boolean)
    .join('/');

/** Every HTTP route of the running application with its declared access rules, read from the Nest metadata. */
export function collectRoutes(app: NestExpressApplication): Route[] {
  const found: Route[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const type = wrapper.metatype as (new () => object) | null;
      if (!type || typeof type !== 'function') continue;
      const basePath = Reflect.getMetadata(PATH_METADATA, type) as string | string[] | undefined;
      if (basePath === undefined) continue;
      const version = Reflect.getMetadata(VERSION_METADATA, type) as string | undefined;
      const proto = type.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const methodIndex = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (methodIndex === undefined) continue;
        const routePath = Reflect.getMetadata(PATH_METADATA, handler) as string | string[];
        const get = <T>(key: string): T | undefined =>
          (Reflect.getMetadata(key, handler) as T | undefined) ??
          (Reflect.getMetadata(key, type) as T | undefined);
        const health = String(basePath).startsWith('health');
        found.push({
          method: METHODS[methodIndex],
          path: join(health ? [] : ['api', version ? `v${version}` : 'v1'], basePath, routePath),
          controller: type.name,
          handler: name,
          isPublic: get<boolean>(IS_PUBLIC_KEY) === true,
          userTypes: get<string[]>(USER_TYPES_KEY) ?? [],
          permissions: get<string[]>(PERMISSIONS_KEY) ?? [],
          roles: get<string[]>(ROLES_KEY) ?? [],
        });
      }
    }
  }
  return found.sort((x, y) => (x.path + x.method).localeCompare(y.path + y.method));
}

/** What route sweeps need to know about an endpoint. `undefined` means "no such restriction declared". */
export interface RouteInfo {
  method: string;
  /** Always written as /api/v1/... (the health probes are really served at /health/*). */
  path: string;
  controller: string;
  handler: string;
  isPublic: boolean;
  userTypes?: string[];
  permissions?: string[];
  roles?: string[];
}

export function listRoutes(app: NestExpressApplication): RouteInfo[] {
  return collectRoutes(app).map((r) => ({
    method: r.method,
    path: r.path.startsWith('/health/') ? `/api/v1${r.path}` : r.path,
    controller: r.controller,
    handler: r.handler,
    isPublic: r.isPublic,
    userTypes: r.userTypes.length ? r.userTypes : undefined,
    permissions: r.permissions.length ? r.permissions : undefined,
    roles: r.roles.length ? r.roles : undefined,
  }));
}

const FIXED_PARAMS: Record<string, string> = {
  ':action': 'cancel',
  ':checkType': 'IDENTITY',
  ':roleCode': 'NO_SUCH_ROLE',
};
const SOME_ID = '00000000-0000-7000-8000-000000000000';

/** Turns /a/:id/b into a requestable path. Guards run before pipes and handlers, so any well-formed value does. */
export function concretePath(path: string): string {
  return path.replace(/:[A-Za-z]+/g, (param) => FIXED_PARAMS[param] ?? SOME_ID);
}
