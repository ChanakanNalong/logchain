import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body of PATCH /alerts/:id/resolve. The note is optional — resolving without
 * one keeps the alert's current resolution note (so an operator can add the
 * note on a later resolve). Stored under detail.resolution, never a new column.
 */
export class ResolveAlertDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
