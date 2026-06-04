import { Controller, Delete, Param, Body } from '@nestjs/common';
import { ErasureService } from './erasure.service';

@Controller('erasure')
export class ErasureController {
  constructor(private readonly erasureService: ErasureService) {}

  @Delete('user/:userId')
  erase(@Param('userId') userId: string, @Body('requestedBy') requestedBy: string) {
    return this.erasureService.eraseUser(userId, requestedBy ?? 'unknown');
  }
}