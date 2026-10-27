# Platform configuration

Values the business owns and the apps read, kept in the database so staff change them without a deployment.

## What is dynamic

| App endpoint          | Fields                                                                                                                                                     | Source                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /app-config`     | `customer.minVersion/storeUrl`, `worker.minVersion/storeUrl`, `maintenance`, `support.phone/email`, `policy.cancellationText/Url`, `policy.refundText/Url` | `app_settings` row if staff set one, otherwise the deployment default (environment), otherwise `null` |
| `GET /reference-data` | `ratingTags`                                                                                                                                               | `rating_tags` (active rows, in `sortOrder`)                                                           |
| `POST /ratings`       | `tags`                                                                                                                                                     | must be active `rating_tags` codes: 422 `RATING_TAG_INVALID` otherwise                                |

Read on every request (no cache inside the API), so a change is visible to the apps at once.

## Admin APIs (`/api/v1/admin`, permission `config.manage`, every change audited)

| Endpoint                                                             | Notes                                                                                                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /app-settings`                                                  | each key with its value and `source` (`DATABASE`, `ENVIRONMENT`, `UNSET`)                                                                                   |
| `PUT /app-settings/{key}` `{ value }`                                | 404 `SETTING_UNKNOWN`; 422 `SETTING_VALUE_INVALID` (versions `1.4.0`, `https://` links, phone, e-mail, `true/false` for `maintenance`, length caps)         |
| `DELETE /app-settings/{key}`                                         | back to the deployment default                                                                                                                              |
| `GET /rating-tags`, `POST /rating-tags`, `PATCH /rating-tags/{code}` | code `A-Z0-9_`, label, `POSITIVE`/`NEGATIVE`, `sortOrder`, `isActive`; a tag is retired (`isActive: false`), never deleted, so old ratings keep their codes |

`config.manage` is held by the Super Admin only until the owner grants it to another role.

## Starting data

The migration inserts the nine rating tags the apps already used (decision D-88; wording still awaits client confirmation, Q-121) as ordinary rows. Nothing else is seeded.

## Deliberately NOT here

Supported languages (validated on every profile write, so they stay deployment configuration), legal document versions (`legal` module), fee amounts (`/admin/fees`), price guidance (`/admin/pricing-guidance`), categories and areas (own masters). Vocabularies tied to a state machine or a database enum (engagement types, budget periods, report reasons, ticket priorities, booking and interview status labels, replacement reasons) are part of the contract and stay in code.
