function cleanTravelText(input: string, max = 160): string {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export const BROAD_DESTINATION_RE =
  /(中国|美国|英国|法国|德国|意大利|西班牙|葡萄牙|荷兰|比利时|瑞士|奥地利|日本|韩国|新加坡|泰国|马来西亚|印度尼西亚|澳大利亚|加拿大|新西兰|阿联酋|摩洛哥|冰岛|欧洲|亚洲|非洲|北美|南美|中东|关西|北海道|东南亚|北欧|南欧|西欧|东欧|japan|china|usa|united states|uk|united kingdom|france|germany|italy|spain|portugal|netherlands|belgium|switzerland|austria|singapore|thailand|malaysia|indonesia|australia|canada|new zealand|uae|morocco|iceland|europe|asia|africa|north america|south america|middle east|kansai|hokkaido|southeast asia|nordics?)/i;

export const TASK_RESTART_RE =
  /(重新规划|新任务|下一趟|再规划一趟|重新开始|重开|新的行程|新的旅行|another trip|new task|start over|restart|fresh plan|next trip)/i;

export const SOFT_TRIP_REQUEST_RE =
  /(?:我想|我们想|想|准备|打算|想要|i want|we want|want to|planning to|plan to|thinking of|would like to).{0,12}(?:去|安排|规划|计划|go|visit|plan|arrange|map out)/i;

export const TRIP_PHASE_CUE_RE =
  /(回程前|返程前|离开前|出发前|临走前|返航前|回家前|回程|返程|departure day|before departure|before leaving|before flying home|last night before|night before departure|return leg|on the way back|on the return|before heading home)/i;

export const ABSTRACT_TRAVEL_MODE_RE =
  /(在地体验|当地体验|当地生活|城市生活|生活感|体验感|不要太硬核|太硬核|硬核一点|local experience|local life|city life|street life|daily life|vibe|atmosphere|feel of the city|too hardcore|hardcore)/i;

export const ABSTRACT_PLACE_RE =
  /(西班牙语地区|英语地区|法语地区|德语地区|语地区|safe area|quiet area|convenient area|affordable area|comfortable area|nearby area|walkable area)|(安全|安静|方便|便宜|舒适|舒服|热闹|清净|治安|人少|不拥挤|离.*近|靠近|附近|safe|quiet|convenient|affordable|comfortable|walkable|nearby).{0,12}(地方|位置|区域|area|place|zone)?/i;

export function looksLikeBroadDestination(text: string): boolean {
  return BROAD_DESTINATION_RE.test(cleanTravelText(text, 80));
}

export function looksLikeTaskRestart(text: string): boolean {
  return TASK_RESTART_RE.test(cleanTravelText(text, 120));
}

export function looksLikeSoftTripRequest(text: string): boolean {
  return SOFT_TRIP_REQUEST_RE.test(cleanTravelText(text, 120));
}

export function looksLikeTripPhaseCueText(text: string): boolean {
  return TRIP_PHASE_CUE_RE.test(cleanTravelText(text, 120));
}

export function looksLikeAbstractTravelModeText(text: string): boolean {
  const cleaned = cleanTravelText(text, 120);
  if (!cleaned) return false;
  return (
    ABSTRACT_TRAVEL_MODE_RE.test(cleaned) ||
    /(?:体验|生活|氛围|步调|节奏|experience|life|vibe|atmosphere)$/i.test(cleaned)
  );
}

export function looksLikeAbstractPlaceText(text: string): boolean {
  return ABSTRACT_PLACE_RE.test(cleanTravelText(text, 120));
}
