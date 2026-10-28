import '../support/env-api-integration';
import { writeFileSync } from 'node:fs';
import { createApiApp } from '../support/api-app';

it('exports the OpenAPI document', async () => {
  const api = await createApiApp();
  const res = await api.http().get('/docs/openapi.json');
  writeFileSync('docs/openapi.json', `${JSON.stringify(res.body, null, 2)}\n`, 'utf8');
  await api.close();
});
