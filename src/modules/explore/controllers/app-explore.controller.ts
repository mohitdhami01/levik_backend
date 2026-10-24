import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { Roles } from '../../../common/decorators/roles.decorator.js';
import { toPage } from '../../../common/dto/pagination.dto.js';
import type { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface.js';
import type { ParticipantRole } from '../bo/explore.bo.js';
import { ExploreDealerQueryDto, ExploreProductQueryDto } from '../dto/explore.request.dto.js';
import { ExploreDealerDetailDto, ExploreDealerListDto, ExploreProductDetailDto, ExploreProductPageDto } from '../dto/explore.response.dto.js';
import { ExploreMapper } from '../mappers/explore.mapper.js';
import { ExploreService } from '../services/explore.service.js';

const callerOf = (user: AuthenticatedUser) => ({ id: user.sub, role: user.role as ParticipantRole });

@ApiTags('App · Explore')
@ApiBearerAuth()
@Roles('plumber', 'retailer')
@Controller('app/explore')
export class AppExploreController {
  constructor(private readonly explore: ExploreService) {}

  /** Catalogue with the caller's points per product; plumbers also see how many dealers stock it, retailers their price. */
  @Get('products')
  async products(@CurrentUser() user: AuthenticatedUser, @Query() query: ExploreProductQueryDto): Promise<ExploreProductPageDto> {
    const page = await this.explore.products(callerOf(user), { page: query.page, pageSize: query.pageSize, search: query.search, category: query.category });
    return toPage(page, ExploreMapper.product);
  }

  /** One product: earnings, live schemes and the dealers stocking it (nearby first). */
  @Get('products/:id')
  async product(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<ExploreProductDetailDto> {
    const { product, dealers, city } = await this.explore.product(callerOf(user), id);
    return { product: ExploreMapper.product(product), dealers: dealers.map(ExploreMapper.dealerStock), city: city ?? undefined };
  }

  /** Listed dealers with how many products each has in stock (nearby first). Plumbers only. */
  @Roles('plumber')
  @Get('dealers')
  async dealers(@CurrentUser() user: AuthenticatedUser, @Query() query: ExploreDealerQueryDto): Promise<ExploreDealerListDto> {
    const { dealers, city } = await this.explore.dealers(callerOf(user), query.search?.trim() || undefined);
    return { dealers: dealers.map(ExploreMapper.dealerSummary), city: city ?? undefined };
  }

  /** One dealer and every product they have in stock, with what each earns. Plumbers only. */
  @Roles('plumber')
  @Get('dealers/:id')
  async dealer(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<ExploreDealerDetailDto> {
    const { dealer, products } = await this.explore.dealer(callerOf(user), id);
    return { dealer: ExploreMapper.dealer(dealer), products: products.map(ExploreMapper.dealerProduct) };
  }
}
