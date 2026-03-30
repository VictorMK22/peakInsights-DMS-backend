export const buildCacheKey = (
    userId: string,
    query: Record<string, any>
  ) => {
    const sorted = Object.keys(query)
      .sort()
      .reduce((acc, key) => {
        acc[key] = query[key];
        return acc;
      }, {} as Record<string, any>);
  
    return `docs:${userId}:${JSON.stringify(sorted)}`;
  };