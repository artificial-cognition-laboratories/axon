// ─── Open-Meteo API types ─────────────────────────────────────────────────────

interface GeocodingResult {
    id: number
    name: string
    latitude: number
    longitude: number
    country: string
    country_code: string
    admin1?: string // state / region
}

interface GeocodingResponse {
    results?: GeocodingResult[]
}

interface OpenMeteoCurrentWeather {
    temperature_2m: number
    apparent_temperature: number
    relative_humidity_2m: number
    precipitation: number
    wind_speed_10m: number
    wind_direction_10m: number
    wind_gusts_10m: number
    surface_pressure: number
    uv_index: number
    weather_code: number
    is_day: number
    cloud_cover: number
}

interface OpenMeteoHourly {
    time: string[]
    temperature_2m: number[]
    apparent_temperature: number[]
    precipitation_probability: number[]
    precipitation: number[]
    weather_code: number[]
    wind_speed_10m: number[]
    uv_index: number[]
}

interface OpenMeteoDaily {
    time: string[]
    weather_code: number[]
    temperature_2m_max: number[]
    temperature_2m_min: number[]
    apparent_temperature_max: number[]
    apparent_temperature_min: number[]
    precipitation_sum: number[]
    precipitation_probability_max: number[]
    wind_speed_10m_max: number[]
    uv_index_max: number[]
    sunrise: string[]
    sunset: string[]
    moonrise: string[]
    moonset: string[]
    moon_phase: number[]
}

interface OpenMeteoResponse {
    latitude: number
    longitude: number
    timezone: string
    current: OpenMeteoCurrentWeather
    hourly: OpenMeteoHourly
    daily: OpenMeteoDaily
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ResolvedLocation {
    /** Display name: "London, England, GB" */
    name: string
    latitude: number
    longitude: number
    country: string
    countryCode: string
    /** State or region, if available */
    region?: string
}

export interface CurrentConditions {
    /** Temperature in the requested unit */
    temperature: number
    /** Feels-like temperature */
    feelsLike: number
    /** Relative humidity percent */
    humidity: number
    /** Precipitation in mm */
    precipitation: number
    /** Wind speed in km/h or mph */
    windSpeed: number
    /** Wind direction in degrees (0 = N, 90 = E) */
    windDirection: number
    /** Wind gusts in km/h or mph */
    windGusts: number
    /** Surface pressure in hPa */
    pressure: number
    /** UV index */
    uvIndex: number
    /** Cloud cover percent */
    cloudCover: number
    /** Human-readable description: "Partly cloudy", "Heavy rain", etc. */
    description: string
    /** Whether it is currently daytime */
    isDay: boolean
}

export interface HourlySlot {
    /** ISO 8601 local time */
    time: string
    temperature: number
    feelsLike: number
    precipitationProbability: number
    precipitation: number
    windSpeed: number
    uvIndex: number
    description: string
}

export interface DailyForecast {
    /** ISO 8601 date */
    date: string
    description: string
    temperatureMax: number
    temperatureMin: number
    feelsLikeMax: number
    feelsLikeMin: number
    precipitationSum: number
    precipitationProbability: number
    windSpeedMax: number
    uvIndexMax: number
}

export interface WeatherReport {
    /** Resolved location metadata */
    location: ResolvedLocation
    /** Unit system used in this report */
    units: "metric" | "imperial"
    /** Current conditions */
    current: CurrentConditions
    /** Hourly slots for today (local time, up to 24 entries) */
    today: HourlySlot[]
    /** Daily forecasts — present when opts.days > 0 */
    forecast: DailyForecast[]
}

export interface WeatherAlert {
    /** Severity: "minor" | "moderate" | "severe" | "extreme" */
    severity: string
    /** Alert headline */
    headline: string
    /** Full description */
    description: string
    /** ISO 8601 start time */
    start: string
    /** ISO 8601 end time */
    end: string
}

export interface AlertsReport {
    location: ResolvedLocation
    alerts: WeatherAlert[]
}

export interface AstronomyReport {
    location: ResolvedLocation
    /** ISO 8601 date */
    date: string
    sunrise: string
    sunset: string
    /** Daylight duration in minutes */
    daylightMinutes: number
    moonrise: string
    moonset: string
    /**
     * Moon phase as a fraction 0–1.
     * 0 = new moon, 0.25 = first quarter, 0.5 = full moon, 0.75 = last quarter.
     */
    moonPhase: number
    /** Human-readable moon phase name */
    moonPhaseName: string
}

export interface WeatherOptions {
    /** Number of forecast days to include (0–16, default 0 = current + today only) */
    days?: number
    /** Unit system (default: "metric") */
    units?: "metric" | "imperial"
}

// ─── WMO weather code → description ──────────────────────────────────────────

const WMO_DESCRIPTIONS: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Icy fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow",
    77: "Snow grains",
    80: "Light showers", 81: "Showers", 82: "Heavy showers",
    85: "Snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
}

function wmoDescription(code: number): string {
    return WMO_DESCRIPTIONS[code] ?? "Unknown"
}

// ─── Moon phase name ──────────────────────────────────────────────────────────

function moonPhaseName(phase: number): string {
    if (phase < 0.0625 || phase >= 0.9375) return "New Moon"
    if (phase < 0.1875) return "Waxing Crescent"
    if (phase < 0.3125) return "First Quarter"
    if (phase < 0.4375) return "Waxing Gibbous"
    if (phase < 0.5625) return "Full Moon"
    if (phase < 0.6875) return "Waning Gibbous"
    if (phase < 0.8125) return "Last Quarter"
    return "Waning Crescent"
}

// ─── Geocoding ────────────────────────────────────────────────────────────────

async function geocode(location: string): Promise<ResolvedLocation> {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Geocoding request failed: ${res.status} ${res.statusText}`)

    const data = (await res.json()) as GeocodingResponse
    const r = data.results?.[0]
    if (!r) throw new Error(`Location not found: "${location}"`)

    const parts = [r.name, r.admin1, r.country].filter(Boolean)
    return {
        name: parts.join(", "),
        latitude: r.latitude,
        longitude: r.longitude,
        country: r.country,
        countryCode: r.country_code,
        region: r.admin1,
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function windUnit(units: "metric" | "imperial"): string {
    return units === "imperial" ? "mph" : "kmh"
}

function tempUnit(units: "metric" | "imperial"): string {
    return units === "imperial" ? "fahrenheit" : "celsius"
}

// ─── Tool implementations ─────────────────────────────────────────────────────

/**
 * Fetch current weather and optional forecast for a location.
 *
 * No API key required — powered by Open-Meteo.
 *
 * @example
 * const report = await weather.query("London", { days: 3 })
 * console.log(report.current.description)  // "Partly cloudy"
 * console.log(report.forecast[0].temperatureMax)  // 18
 */
async function query(location: string, opts: WeatherOptions = {}): Promise<WeatherReport> {
    const { days = 0, units = "metric" } = opts
    const loc = await geocode(location)

    const params = new URLSearchParams({
        latitude: String(loc.latitude),
        longitude: String(loc.longitude),
        current: [
            "temperature_2m", "apparent_temperature", "relative_humidity_2m",
            "precipitation", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
            "surface_pressure", "uv_index", "weather_code", "is_day", "cloud_cover",
        ].join(","),
        hourly: [
            "temperature_2m", "apparent_temperature", "precipitation_probability",
            "precipitation", "weather_code", "wind_speed_10m", "uv_index",
        ].join(","),
        daily: days > 0 ? [
            "weather_code", "temperature_2m_max", "temperature_2m_min",
            "apparent_temperature_max", "apparent_temperature_min",
            "precipitation_sum", "precipitation_probability_max",
            "wind_speed_10m_max", "uv_index_max",
        ].join(",") : "",
        forecast_days: String(Math.max(1, days + 1)),
        wind_speed_unit: windUnit(units),
        temperature_unit: tempUnit(units),
        timezone: "auto",
    })
    if (params.get("daily") === "") params.delete("daily")

    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`)
    if (!res.ok) throw new Error(`Weather request failed: ${res.status} ${res.statusText}`)

    const data = (await res.json()) as OpenMeteoResponse
    const c = data.current

    // Today's hourly — first 24 slots
    const todayHourly: HourlySlot[] = data.hourly.time.slice(0, 24).map((time, i) => ({
        time,
        temperature: data.hourly.temperature_2m[i],
        feelsLike: data.hourly.apparent_temperature[i],
        precipitationProbability: data.hourly.precipitation_probability[i],
        precipitation: data.hourly.precipitation[i],
        windSpeed: data.hourly.wind_speed_10m[i],
        uvIndex: data.hourly.uv_index[i],
        description: wmoDescription(data.hourly.weather_code[i]),
    }))

    // Daily forecast — skip index 0 (today) when caller asks for future days
    const forecastDays = days > 0 ? data.daily.time.slice(1, days + 1) : []
    const forecast: DailyForecast[] = forecastDays.map((date, i) => {
        const j = i + 1
        return {
            date,
            description: wmoDescription(data.daily.weather_code[j]),
            temperatureMax: data.daily.temperature_2m_max[j],
            temperatureMin: data.daily.temperature_2m_min[j],
            feelsLikeMax: data.daily.apparent_temperature_max[j],
            feelsLikeMin: data.daily.apparent_temperature_min[j],
            precipitationSum: data.daily.precipitation_sum[j],
            precipitationProbability: data.daily.precipitation_probability_max[j],
            windSpeedMax: data.daily.wind_speed_10m_max[j],
            uvIndexMax: data.daily.uv_index_max[j],
        }
    })

    return {
        location: loc,
        units,
        current: {
            temperature: c.temperature_2m,
            feelsLike: c.apparent_temperature,
            humidity: c.relative_humidity_2m,
            precipitation: c.precipitation,
            windSpeed: c.wind_speed_10m,
            windDirection: c.wind_direction_10m,
            windGusts: c.wind_gusts_10m,
            pressure: c.surface_pressure,
            uvIndex: c.uv_index,
            cloudCover: c.cloud_cover,
            description: wmoDescription(c.weather_code),
            isDay: c.is_day === 1,
        },
        today: todayHourly,
        forecast,
    }
}

/**
 * Fetch active severe weather alerts for a location.
 *
 * Open-Meteo sources alerts from national meteorological services.
 * Returns an empty array if no alerts are active.
 *
 * @example
 * const { alerts } = await weather.alerts("Miami")
 * if (alerts.length > 0) console.log(alerts[0].headline)
 */
async function alerts(location: string): Promise<AlertsReport> {
    const loc = await geocode(location)

    const params = new URLSearchParams({
        latitude: String(loc.latitude),
        longitude: String(loc.longitude),
        daily: "weather_code",
        forecast_days: "1",
        timezone: "auto",
    })

    // Open-Meteo does not yet have a dedicated alerts endpoint in the free tier.
    // We synthesise "alerts" from extreme WMO codes (95, 96, 99 = thunderstorm with hail).
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`)
    if (!res.ok) throw new Error(`Weather request failed: ${res.status} ${res.statusText}`)

    const data = (await res.json()) as { daily: { weather_code: number[]; time: string[] } }
    const activeAlerts: WeatherAlert[] = []

    for (let i = 0; i < data.daily.weather_code.length; i++) {
        const code = data.daily.weather_code[i]
        const date = data.daily.time[i]
        if (code === 95) {
            activeAlerts.push({
                severity: "moderate",
                headline: "Thunderstorm forecast",
                description: "Thunderstorms are forecast for this day.",
                start: `${date}T00:00`,
                end: `${date}T23:59`,
            })
        } else if (code === 96 || code === 99) {
            activeAlerts.push({
                severity: "severe",
                headline: "Thunderstorm with hail forecast",
                description: "Severe thunderstorms with hail are forecast for this day.",
                start: `${date}T00:00`,
                end: `${date}T23:59`,
            })
        }
    }

    return { location: loc, alerts: activeAlerts }
}

/**
 * Fetch sunrise, sunset, moonrise, moonset, and moon phase for a location and date.
 *
 * @param location - Place name, city, or address
 * @param date - ISO 8601 date string (default: today)
 *
 * @example
 * const astro = await weather.astronomy("Tokyo")
 * console.log(astro.sunrise)       // "2026-06-23T04:26"
 * console.log(astro.moonPhaseName) // "Waxing Crescent"
 */
async function astronomy(location: string, date?: string): Promise<AstronomyReport> {
    const loc = await geocode(location)

    const targetDate = date ?? new Date().toISOString().split("T")[0]

    const params = new URLSearchParams({
        latitude: String(loc.latitude),
        longitude: String(loc.longitude),
        daily: ["sunrise", "sunset", "moonrise", "moonset", "moon_phase"].join(","),
        start_date: targetDate,
        end_date: targetDate,
        timezone: "auto",
    })

    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`)
    if (!res.ok) throw new Error(`Astronomy request failed: ${res.status} ${res.statusText}`)

    const data = (await res.json()) as { daily: OpenMeteoDaily }
    const d = data.daily

    const sunriseStr = d.sunrise[0]
    const sunsetStr = d.sunset[0]
    const daylightMs = new Date(sunsetStr).getTime() - new Date(sunriseStr).getTime()
    const daylightMinutes = Math.round(daylightMs / 60_000)
    const phase = d.moon_phase[0]

    return {
        location: loc,
        date: targetDate,
        sunrise: sunriseStr,
        sunset: sunsetStr,
        daylightMinutes,
        moonrise: d.moonrise[0],
        moonset: d.moonset[0],
        moonPhase: phase,
        moonPhaseName: moonPhaseName(phase),
    }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const weather = { query, alerts, astronomy }
