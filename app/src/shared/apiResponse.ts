/** Standard JSON envelopes returned by the hub API. */
export interface SingleResponse<T> { data: T }
export interface ListResponse<T> { data: T[] }

/** Paginated list envelope (data + page metadata). */
export interface PaginatedResponse<T> {
	data: T[]
	meta: {
		page: number
		limit: number
		total: number
		pages: number
	}
}
