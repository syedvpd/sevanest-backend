import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import type { Response } from 'express';
import { etagOf } from '../../common/concurrency/if-match';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { PageQueryDto } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import { CustomerAddressesService } from './customer-addresses.service';
import { CustomersService } from './customers.service';
import {
  AddressResponse,
  AdminCustomerDetail,
  AdminCustomerListQuery,
  AdminCustomerSummary,
  CreateAddressDto,
  CreateCustomerNoteDto,
  CreateCustomerProfileDto,
  CustomerNoteResponse,
  CustomerOnboardingResponse,
  CustomerProfileResponse,
  UpdateAddressDto,
  UpdateCustomerProfileDto,
  UpdateVerificationStatusDto,
} from './dto/customers.dto';

/** The signed-in customer's own profile and addresses. Everything is scoped to the authenticated user, never to an id from the client. */
@ApiTags('Customers')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ path: 'customers/me', version: '1' })
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly addresses: CustomerAddressesService,
  ) {}

  @Post()
  @ApiModelResponse(CustomerProfileResponse, { status: 201 })
  @ApiOperation({ summary: 'Create my profile after OTP registration (409 if it already exists)' })
  createProfile(
    @Body() dto: CreateCustomerProfileDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CustomerProfileResponse> {
    return this.customers.createMyProfile(user.userId, dto);
  }

  @Get('onboarding')
  @ApiModelResponse(CustomerOnboardingResponse)
  @ApiOperation({
    summary: 'My onboarding progress: profile, address, verification and the next step',
    description:
      'Works before the profile exists (profileCreated=false, nextStep=PROFILE). Steps are saved by POST /customers/me, PATCH /customers/me and POST /customers/me/addresses.',
  })
  onboarding(@CurrentUser() user: AuthenticatedUser): Promise<CustomerOnboardingResponse> {
    return this.customers.onboarding(user.userId);
  }

  @Get()
  @ApiModelResponse(CustomerProfileResponse)
  @ApiOperation({ summary: 'Get my profile (404 CUSTOMER_PROFILE_NOT_FOUND until it is created)' })
  async getProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerProfileResponse> {
    const profile = await this.customers.getMyProfile(user.userId);
    res.setHeader('ETag', etagOf(profile.updatedAt));
    return profile;
  }

  @Patch()
  @ApiModelResponse(CustomerProfileResponse)
  @ApiOperation({
    summary: 'Update my name, email or preferred language',
    description:
      'Only these three fields are writable. Mobile (verified by OTP) and verification status cannot be changed here. Send If-Match with the ETag of the last GET to refuse the edit (412 STALE_VERSION) when the profile changed meanwhile (for example on another device).',
  })
  async updateProfile(
    @Body() dto: UpdateCustomerProfileDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerProfileResponse> {
    const profile = await this.customers.updateMyProfile(user.userId, dto, ifMatch);
    res.setHeader('ETag', etagOf(profile.updatedAt));
    return profile;
  }

  @Get('addresses')
  @ApiModelResponse(AddressResponse, { isArray: true })
  @ApiOperation({ summary: 'List my active saved addresses (default first)' })
  listAddresses(@CurrentUser() user: AuthenticatedUser): Promise<AddressResponse[]> {
    return this.addresses.list(user.userId);
  }

  @Post('addresses')
  @ApiModelResponse(AddressResponse, { status: 201 })
  @ApiOperation({ summary: 'Save an address; isDefault=true replaces the current default' })
  createAddress(
    @Body() dto: CreateAddressDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AddressResponse> {
    return this.addresses.create(user.userId, dto);
  }

  @Get('addresses/:addressId')
  @ApiModelResponse(AddressResponse)
  @ApiOperation({ summary: "Get one of my addresses (404 for anyone else's)" })
  async getAddress(
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AddressResponse> {
    const address = await this.addresses.get(user.userId, addressId);
    res.setHeader('ETag', etagOf(address.updatedAt));
    return address;
  }

  @Patch('addresses/:addressId')
  @ApiModelResponse(AddressResponse)
  @ApiOperation({
    summary: 'Edit an address',
    description:
      'Send latitude and longitude together; null for both clears the map location. The default flag changes only via PUT .../default.',
  })
  async updateAddress(
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @Body() dto: UpdateAddressDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AddressResponse> {
    const address = await this.addresses.update(user.userId, addressId, dto, ifMatch);
    res.setHeader('ETag', etagOf(address.updatedAt));
    return address;
  }

  @Put('addresses/:addressId/default')
  @ApiModelResponse(AddressResponse)
  @ApiOperation({ summary: 'Make this my default address (idempotent)' })
  setDefaultAddress(
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AddressResponse> {
    return this.addresses.setDefault(user.userId, addressId);
  }

  @Delete('addresses/:addressId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove an address (soft: kept for future bookings, hidden from me)',
    description: 'Removing the default address leaves no default until another is chosen.',
  })
  async deleteAddress(
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.addresses.deactivate(user.userId, addressId);
  }
}

/** Admin customer management (FRD FM-02). Suspension is done through PATCH /admin/users/{userId}/status. */
@ApiTags('Admin - Customers')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/customers', version: '1' })
export class AdminCustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @ApiPageResponse(AdminCustomerSummary)
  @Permissions(PermissionCode.CUSTOMER_VIEW)
  @ApiOperation({ summary: 'List customers (paginated, mobile masked)' })
  list(@Query() query: AdminCustomerListQuery): Promise<Page<AdminCustomerSummary>> {
    return this.customers.adminList(query);
  }

  @Get(':customerId')
  @ApiModelResponse(AdminCustomerDetail)
  @Permissions(PermissionCode.CUSTOMER_VIEW)
  @ApiOperation({ summary: 'Customer profile with all addresses and account status' })
  async get(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminCustomerDetail> {
    const detail = await this.customers.adminGet(customerId);
    res.setHeader('ETag', etagOf(detail.updatedAt));
    return detail;
  }

  @Patch(':customerId/verification-status')
  @ApiModelResponse(AdminCustomerSummary)
  @Permissions(PermissionCode.CUSTOMER_MANAGE)
  @ApiOperation({
    summary: 'Set the customer verification status (audited with before/after)',
    description:
      'Send If-Match with the ETag of the GET to refuse the change (412 STALE_VERSION) when the profile changed meanwhile.',
  })
  async setVerificationStatus(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: UpdateVerificationStatusDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<AdminCustomerSummary> {
    const access = await this.users.getAccess(admin.userId);
    return this.customers.adminSetVerificationStatus(
      customerId,
      dto.status,
      dto.note,
      { userId: admin.userId, roles: access.roles },
      ifMatch,
    );
  }

  @Post(':customerId/notes')
  @ApiModelResponse(CustomerNoteResponse, { status: 201 })
  @Permissions(PermissionCode.CUSTOMER_MANAGE)
  @ApiOperation({ summary: 'Add an operational note to a customer' })
  async addNote(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: CreateCustomerNoteDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<CustomerNoteResponse> {
    const access = await this.users.getAccess(admin.userId);
    return this.customers.adminAddNote(customerId, dto.note, {
      userId: admin.userId,
      roles: access.roles,
    });
  }

  @Get(':customerId/notes')
  @ApiPageResponse(CustomerNoteResponse)
  @Permissions(PermissionCode.CUSTOMER_VIEW)
  @ApiOperation({ summary: 'List customer notes (paginated, newest first)' })
  listNotes(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: PageQueryDto,
  ): Promise<Page<CustomerNoteResponse>> {
    return this.customers.adminListNotes(customerId, query);
  }
}
