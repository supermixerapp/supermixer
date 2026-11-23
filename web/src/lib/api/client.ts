import createClient from 'openapi-fetch'

import type { components, paths } from './schema.gen'

/** Typed client for the Supermixer REST API (generated from api/openapi.yaml). */
export const api = createClient<paths>({ baseUrl: '/api/v1' })

export type Schemas = components['schemas']
