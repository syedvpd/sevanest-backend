import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiResponse, getSchemaPath } from '@nestjs/swagger';

/** The `meta` object of every paginated list (`{ data, meta: { page, limit, total } }`). `total` is always present. */
export class PageMetaView {
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
  @ApiProperty({ example: 57, description: 'Total rows matching the query, always present.' })
  total!: number;
}

/** Documents a single-object (or array) response body. The project does not use the Swagger CLI plugin, so this is explicit. */
export function ApiModelResponse(
  model: Type<unknown>,
  options: { status?: number; isArray?: boolean } = {},
): MethodDecorator {
  return applyDecorators(
    ApiExtraModels(model),
    ApiResponse({ status: options.status ?? 200, type: model, isArray: options.isArray }),
  );
}

/** Documents the standard list envelope `{ data: Model[], meta: { page, limit, total } }`. */
export function ApiPageResponse(model: Type<unknown>, status = 200): MethodDecorator {
  return applyDecorators(
    ApiExtraModels(model, PageMetaView),
    ApiResponse({
      status,
      schema: {
        type: 'object',
        required: ['data', 'meta'],
        properties: {
          data: { type: 'array', items: { $ref: getSchemaPath(model) } },
          meta: { $ref: getSchemaPath(PageMetaView) },
        },
      },
    }),
  );
}
