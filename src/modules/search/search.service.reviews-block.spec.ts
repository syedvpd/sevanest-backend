import { SearchService } from './search.service';

/** Regression: the reviews route must apply the caller's block rule exactly like the profile route. */
describe('SearchService.listReviews block rule', () => {
  it('asks for the worker with the caller id, and answers 404 when the worker is hidden by a block', async () => {
    const findVisibleByIds = jest.fn().mockResolvedValue([]); // a blocked worker is not returned for this caller
    const empty = jest.fn().mockResolvedValue(new Map());
    const repository = {
      findVisibleByIds,
      listVisibleReviews: jest.fn(),
      ratingSummaries: empty,
      verifiedIds: jest.fn().mockResolvedValue(new Set()),
      visibleCategories: empty,
    };
    const service = new SearchService(
      repository as never,
      {} as never,
      {} as never,
      { linksFor: jest.fn().mockResolvedValue(new Map()) } as never,
      { search: { cacheTtlSeconds: 0 } } as never,
    );
    await expect(
      service.listReviews('worker-1', { page: 1, limit: 20 }, 'customer-1'),
    ).rejects.toMatchObject({ status: 404 });
    expect(findVisibleByIds).toHaveBeenCalledWith(['worker-1'], 'customer-1');
    expect(repository.listVisibleReviews).not.toHaveBeenCalled();
  });
});
