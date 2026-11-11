export const PRESET_ID = 'dsh-livestream-douyin';
export const ALLOWED_TOOLS = ['public_search', 'show_stats', 'weather_lookup'];

export function personaChecks(text: string) {
  return {
    originalQuery: text.includes('逐字复制用户当前问题原文'),
    sourceTime: text.includes('来源名') && text.includes('时间限制'),
    limited: text.includes('limited') && text.includes('unknown'),
    noLongUrl: text.includes('不朗读长链接'),
  };
}

export function observeComposition(text: string, schemas: any[]) {
  const toolSchemas = schemas.map((schema) => schema?.name)
    .filter((name): name is string => typeof name === 'string').sort();
  const publicSearch = JSON.stringify(schemas.find((schema) => schema?.name === 'public_search') ?? {});
  const weather = JSON.stringify(schemas.find((schema) => schema?.name === 'weather_lookup') ?? {});
  const schemaChecks = {
    publicQueryOriginal: publicSearch.includes('原文') && publicSearch.includes('不得改写'),
    publicQueryLimit: publicSearch.includes('70'),
    weatherLocation: weather.includes('location') && weather.includes('string'),
  };
  return { toolSchemas, schemaChecks, personaChecks: personaChecks(text) };
}

export function validComposition(composition: ReturnType<typeof observeComposition>): boolean {
  return JSON.stringify(composition.toolSchemas) === JSON.stringify(ALLOWED_TOOLS)
    && Object.values(composition.schemaChecks).every(Boolean)
    && Object.values(composition.personaChecks).every(Boolean);
}
