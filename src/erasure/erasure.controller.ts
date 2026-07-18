import { Controller, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard, Roles } from '../auth/guards/roles.guard';
import { ErasureService } from './erasure.service';

// PDPA right-to-erasure — admin-only (sensitive operation)
@Controller('erasure')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
export class ErasureController {
  constructor(private readonly erasureService: ErasureService) {}

  @Delete('user/:userId')
  erase(
    @Param('userId') userId: string,
    @Body('requestedBy') requestedBy: string,
  ) {
    return this.erasureService.eraseUser(userId, requestedBy ?? 'unknown');
  }
}
