import { fileUrl, imageLink } from '../../uploads/file-url.js';
import type { DealerProductBo, DealerRowBo, DealerStockBo, DealerSummaryBo, ExploreProductBo } from '../bo/explore.bo.js';
import type {
  ExploreDealerDto,
  ExploreDealerProductDto,
  ExploreDealerStockDto,
  ExploreDealerSummaryDto,
  ExploreProductDto,
} from '../dto/explore.response.dto.js';

export const ExploreMapper = {
  product(bo: ExploreProductBo): ExploreProductDto {
    return {
      id: bo.id,
      name: bo.name,
      modelCode: bo.modelCode,
      category: bo.category,
      description: bo.description,
      dimensions: bo.dimensions ?? undefined,
      features: bo.features ?? [],
      imageUrl: imageLink(bo.imageUrl),
      rewardEligible: bo.rewardEligible,
      dealersInStock: bo.dealersInStock ?? undefined,
      listPrice: bo.listPrice ?? undefined,
      earning: {
        points: bo.earning.points,
        basis: bo.earning.basis,
        schemes: bo.earning.schemes.map((s) => ({ ...s, endDate: new Date(s.endDate).toISOString() })),
      },
    };
  },

  dealer(bo: DealerRowBo): ExploreDealerDto {
    return {
      id: bo.id,
      shopName: bo.shopName,
      address: bo.address,
      city: bo.city,
      state: bo.state,
      mobile: bo.mobile,
      shopPhotoUrl: fileUrl(bo.shopPhotoKey),
      sameCity: bo.sameCity,
    };
  },

  dealerStock(bo: DealerStockBo): ExploreDealerStockDto {
    return { ...ExploreMapper.dealer(bo), quantity: bo.quantity, stockLevel: bo.stockLevel, updatedAt: new Date(bo.updatedAt).toISOString() };
  },

  dealerSummary(bo: DealerSummaryBo): ExploreDealerSummaryDto {
    return { ...ExploreMapper.dealer(bo), productsInStock: bo.productsInStock };
  },

  dealerProduct(bo: DealerProductBo): ExploreDealerProductDto {
    return { ...ExploreMapper.product(bo), quantity: bo.quantity, stockLevel: bo.stockLevel };
  },
};
