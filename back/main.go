package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/time/rate"
)

var db *pgxpool.Pool

func initDB() {
	dbURL := os.Getenv("DB_URL")
	if dbURL == "" {
		log.Fatal("DB_URL environment variable is required")
	}
	var err error
	for i := 0; i < 10; i++ {
		db, err = pgxpool.New(context.Background(), dbURL)
		if err == nil {
			if pingErr := db.Ping(context.Background()); pingErr == nil {
				log.Println("Connected to database")
				migrate()
				return
			}
		}
		log.Printf("DB not ready, retrying in 2s... (%d/10)", i+1)
		time.Sleep(2 * time.Second)
	}
	log.Fatal("Could not connect to database:", err)
}

func migrate() {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id    SERIAL PRIMARY KEY,
			name  VARCHAR(255) NOT NULL,
			email VARCHAR(255) NOT NULL UNIQUE
		)`,
		`CREATE TABLE IF NOT EXISTS markers (
			id         SERIAL PRIMARY KEY,
			name       VARCHAR(255) NOT NULL,
			ip         VARCHAR(45),
			lat        DOUBLE PRECISION NOT NULL,
			lon        DOUBLE PRECISION NOT NULL,
			country    VARCHAR(255),
			city       VARCHAR(255),
			expires_at TIMESTAMP,
			created_at TIMESTAMP DEFAULT NOW()
		)`,
		`ALTER TABLE markers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP`,
		`CREATE TABLE IF NOT EXISTS tracking_links (
			id                  SERIAL PRIMARY KEY,
			token               VARCHAR(255) NOT NULL,
			name                VARCHAR(255) NOT NULL,
			expires_hours       INTEGER NOT NULL DEFAULT 0,
			path_prefix         VARCHAR(20) NOT NULL DEFAULT 'track',
			requires_validation BOOLEAN NOT NULL DEFAULT true,
			created_at          TIMESTAMP DEFAULT NOW()
		)`,
		`ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS requires_validation BOOLEAN NOT NULL DEFAULT true`,
		`ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS path_prefix VARCHAR(20) NOT NULL DEFAULT 'track'`,
		`DO $$ BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_constraint WHERE conname = 'tracking_links_prefix_slug_unique'
			) THEN
				ALTER TABLE tracking_links DROP CONSTRAINT IF EXISTS tracking_links_token_key;
				ALTER TABLE tracking_links ADD CONSTRAINT tracking_links_prefix_slug_unique UNIQUE (path_prefix, token);
			END IF;
		END $$`,
		`ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS single_use BOOLEAN NOT NULL DEFAULT false`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(context.Background(), s); err != nil {
			log.Fatalf("migration failed: %v\nstmt: %s", err, s)
		}
	}
	log.Println("Migrations applied")
}

type ipLimiter struct {
	mu       sync.Mutex
	limiters map[string]*rate.Limiter
}

var limiter = &ipLimiter{limiters: make(map[string]*rate.Limiter)}

func (il *ipLimiter) get(ip string) *rate.Limiter {
	il.mu.Lock()
	defer il.mu.Unlock()
	if l, ok := il.limiters[ip]; ok {
		return l
	}
	l := rate.NewLimiter(rate.Every(time.Second), 30)
	il.limiters[ip] = l
	return l
}

func rateLimitMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !limiter.get(c.ClientIP()).Allow() {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "rate limit exceeded"})
			return
		}
		c.Next()
	}
}

func adminKeyMiddleware() gin.HandlerFunc {
	key := os.Getenv("ADMIN_API_KEY")
	return func(c *gin.Context) {
		if c.GetHeader("X-Admin-Key") != key {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Next()
	}
}

func healthHandler(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func listUsers(c *gin.Context) {
	rows, err := db.Query(context.Background(), "SELECT id, name, email FROM users ORDER BY id")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	type User struct {
		ID    int    `json:"id"`
		Name  string `json:"name"`
		Email string `json:"email"`
	}
	var users []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Name, &u.Email); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		users = append(users, u)
	}
	if users == nil {
		users = []User{}
	}
	c.JSON(http.StatusOK, users)
}

func createUser(c *gin.Context) {
	var body struct {
		Name  string `json:"name"  binding:"required"`
		Email string `json:"email" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var id int
	err := db.QueryRow(context.Background(),
		"INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
		body.Name, body.Email,
	).Scan(&id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id, "name": body.Name, "email": body.Email})
}

type IPInfo struct {
	Status      string  `json:"status"`
	Country     string  `json:"country"`
	CountryCode string  `json:"countryCode"`
	Region      string  `json:"region"`
	RegionName  string  `json:"regionName"`
	City        string  `json:"city"`
	Zip         string  `json:"zip"`
	Lat         float64 `json:"lat"`
	Lon         float64 `json:"lon"`
	Timezone    string  `json:"timezone"`
	ISP         string  `json:"isp"`
	Org         string  `json:"org"`
	AS          string  `json:"as"`
	Query       string  `json:"query"`
	Proxy       bool    `json:"proxy"`
	Hosting     bool    `json:"hosting"`
	Mobile      bool    `json:"mobile"`
	Message     string  `json:"message,omitempty"`
}

var httpClient = &http.Client{Timeout: 5 * time.Second}

func fetchIPInfo(ip string) (*IPInfo, error) {
	url := fmt.Sprintf(
		"http://ip-api.com/json/%s?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query,proxy,hosting,mobile",
		ip,
	)
	resp, err := httpClient.Get(url)
	if err != nil {
		return nil, fmt.Errorf("upstream request failed")
	}
	defer resp.Body.Close()
	var info IPInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil, fmt.Errorf("failed to decode response")
	}
	if info.Status != "success" {
		return nil, fmt.Errorf("%s", info.Message)
	}
	return &info, nil
}

var privateBlocks = func() []*net.IPNet {
	cidrs := []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "::1/128"}
	blocks := make([]*net.IPNet, len(cidrs))
	for i, cidr := range cidrs {
		_, blocks[i], _ = net.ParseCIDR(cidr)
	}
	return blocks
}()

func isPrivate(ip string) bool {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return true
	}
	for _, block := range privateBlocks {
		if block.Contains(parsed) {
			return true
		}
	}
	return false
}

func resolveClientIP(c *gin.Context) (string, error) {
	ip := c.GetHeader("X-Real-IP")
	if ip == "" {
		ip = c.ClientIP()
	}
	if isPrivate(ip) {
		resp, err := httpClient.Get("https://api.ipify.org")
		if err != nil {
			return "", fmt.Errorf("could not determine public IP")
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		ip = strings.TrimSpace(string(body))
	}
	return ip, nil
}

func lookupIP(c *gin.Context) {
	info, err := fetchIPInfo(c.Param("ip"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, info)
}

func lookupSelf(c *gin.Context) {
	ip, err := resolveClientIP(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	info, err := fetchIPInfo(ip)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, info)
}

var sseHub = struct {
	mu      sync.Mutex
	clients map[chan []byte]bool
}{clients: make(map[chan []byte]bool)}

func broadcastMarker(m Marker) {
	data, _ := json.Marshal(m)
	sseHub.mu.Lock()
	defer sseHub.mu.Unlock()
	for ch := range sseHub.clients {
		select {
		case ch <- data:
		default:
		}
	}
}

func subscribeSSE(c *gin.Context) {
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")

	ch := make(chan []byte, 16)
	sseHub.mu.Lock()
	sseHub.clients[ch] = true
	sseHub.mu.Unlock()

	defer func() {
		sseHub.mu.Lock()
		delete(sseHub.clients, ch)
		close(ch)
		sseHub.mu.Unlock()
	}()

	flusher, _ := c.Writer.(http.Flusher)
	ctx := c.Request.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case data, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(c.Writer, "data: %s\n\n", data)
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
}

type Marker struct {
	ID      int     `json:"id"`
	Name    string  `json:"name"`
	IP      string  `json:"ip"`
	Lat     float64 `json:"lat"`
	Lon     float64 `json:"lon"`
	Country string  `json:"country"`
	City    string  `json:"city"`
}

func listMarkers(c *gin.Context) {
	rows, err := db.Query(context.Background(),
		"SELECT id, name, ip, lat, lon, country, city FROM markers WHERE expires_at IS NULL OR expires_at > NOW() ORDER BY id")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	var markers []Marker
	for rows.Next() {
		var m Marker
		if err := rows.Scan(&m.ID, &m.Name, &m.IP, &m.Lat, &m.Lon, &m.Country, &m.City); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		markers = append(markers, m)
	}
	if markers == nil {
		markers = []Marker{}
	}
	c.JSON(http.StatusOK, markers)
}

func createMarker(c *gin.Context) {
	var body struct {
		Name    string  `json:"name"    binding:"required"`
		IP      string  `json:"ip"`
		Lat     float64 `json:"lat"     binding:"required"`
		Lon     float64 `json:"lon"`
		Country string  `json:"country"`
		City    string  `json:"city"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var id int
	err := db.QueryRow(context.Background(),
		"INSERT INTO markers (name, ip, lat, lon, country, city) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
		body.Name, body.IP, body.Lat, body.Lon, body.Country, body.City,
	).Scan(&id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	m := Marker{ID: id, Name: body.Name, IP: body.IP, Lat: body.Lat, Lon: body.Lon, Country: body.Country, City: body.City}
	broadcastMarker(m)
	c.JSON(http.StatusCreated, m)
}

func deleteMarker(c *gin.Context) {
	id := c.Param("id")
	tag, err := db.Exec(context.Background(), "DELETE FROM markers WHERE id = $1", id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "marker not found"})
		return
	}
	c.Status(http.StatusNoContent)
}

type TrackingLink struct {
	ID                 int    `json:"id"`
	Token              string `json:"token"`
	Name               string `json:"name"`
	ExpiresHours       int    `json:"expires_hours"`
	PathPrefix         string `json:"path_prefix"`
	RequiresValidation bool   `json:"requires_validation"`
	SingleUse          bool   `json:"single_use"`
}

var validPrefixes = map[string]bool{"track": true, "visit": true, "ping": true, "join": true}

func generateToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func checkSlug(c *gin.Context) {
	prefix := c.Query("prefix")
	slug := c.Query("slug")
	if !validPrefixes[prefix] || slug == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid prefix or empty slug"})
		return
	}
	var count int
	db.QueryRow(context.Background(),
		"SELECT COUNT(*) FROM tracking_links WHERE path_prefix = $1 AND token = $2",
		prefix, slug,
	).Scan(&count)
	c.JSON(http.StatusOK, gin.H{"available": count == 0})
}

func createLink(c *gin.Context) {
	var body struct {
		Name               string `json:"name"                binding:"required"`
		ExpiresHours       int    `json:"expires_hours"`
		PathPrefix         string `json:"path_prefix"`
		Slug               string `json:"slug"`
		RequiresValidation bool   `json:"requires_validation"`
		SingleUse          bool   `json:"single_use"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.PathPrefix == "" {
		body.PathPrefix = "track"
	}
	if !validPrefixes[body.PathPrefix] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid path prefix"})
		return
	}

	slug := strings.TrimSpace(body.Slug)
	if slug == "" {
		var err error
		slug, err = generateToken()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate token"})
			return
		}
	} else {
		var count int
		db.QueryRow(context.Background(),
			"SELECT COUNT(*) FROM tracking_links WHERE path_prefix = $1 AND token = $2",
			body.PathPrefix, slug,
		).Scan(&count)
		if count > 0 {
			c.JSON(http.StatusConflict, gin.H{"error": "slug already in use"})
			return
		}
	}

	var id int
	err := db.QueryRow(context.Background(),
		"INSERT INTO tracking_links (token, name, expires_hours, path_prefix, requires_validation, single_use) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
		slug, body.Name, body.ExpiresHours, body.PathPrefix, body.RequiresValidation, body.SingleUse,
	).Scan(&id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, TrackingLink{
		ID: id, Token: slug, Name: body.Name,
		ExpiresHours: body.ExpiresHours, PathPrefix: body.PathPrefix,
		RequiresValidation: body.RequiresValidation, SingleUse: body.SingleUse,
	})
}

func listLinks(c *gin.Context) {
	rows, err := db.Query(context.Background(),
		"SELECT id, token, name, expires_hours, path_prefix, requires_validation, single_use FROM tracking_links ORDER BY id")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	var links []TrackingLink
	for rows.Next() {
		var l TrackingLink
		if err := rows.Scan(&l.ID, &l.Token, &l.Name, &l.ExpiresHours, &l.PathPrefix, &l.RequiresValidation, &l.SingleUse); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		links = append(links, l)
	}
	if links == nil {
		links = []TrackingLink{}
	}
	c.JSON(http.StatusOK, links)
}

func deleteLink(c *gin.Context) {
	token := c.Param("token")
	tag, err := db.Exec(context.Background(), "DELETE FROM tracking_links WHERE token = $1", token)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if tag.RowsAffected() == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "link not found"})
		return
	}
	c.Status(http.StatusNoContent)
}

func getLinkInfo(c *gin.Context) {
	prefix := c.Param("prefix")
	slug := c.Param("slug")
	var link TrackingLink
	err := db.QueryRow(context.Background(),
		"SELECT id, token, name, expires_hours, path_prefix, requires_validation, single_use FROM tracking_links WHERE path_prefix = $1 AND token = $2",
		prefix, slug,
	).Scan(&link.ID, &link.Token, &link.Name, &link.ExpiresHours, &link.PathPrefix, &link.RequiresValidation, &link.SingleUse)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "link not found"})
		return
	}
	c.JSON(http.StatusOK, link)
}

func trackVisitor(c *gin.Context) {
	prefix := c.Param("prefix")
	slug := c.Param("slug")
	var link TrackingLink
	err := db.QueryRow(context.Background(),
		"SELECT id, token, name, expires_hours, path_prefix, requires_validation, single_use FROM tracking_links WHERE path_prefix = $1 AND token = $2",
		prefix, slug,
	).Scan(&link.ID, &link.Token, &link.Name, &link.ExpiresHours, &link.PathPrefix, &link.RequiresValidation, &link.SingleUse)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "link not found"})
		return
	}

	ip, err := resolveClientIP(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	info, err := fetchIPInfo(ip)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var expiresAt *time.Time
	if link.ExpiresHours > 0 {
		t := time.Now().Add(time.Duration(link.ExpiresHours) * time.Hour)
		expiresAt = &t
	}

	var id int
	err = db.QueryRow(context.Background(),
		"INSERT INTO markers (name, ip, lat, lon, country, city, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
		link.Name, ip, info.Lat, info.Lon, info.Country, info.City, expiresAt,
	).Scan(&id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	m := Marker{ID: id, Name: link.Name, IP: ip, Lat: info.Lat, Lon: info.Lon, Country: info.Country, City: info.City}
	broadcastMarker(m)

	if link.SingleUse {
		db.Exec(context.Background(), "DELETE FROM tracking_links WHERE id = $1", link.ID)
	}

	c.JSON(http.StatusCreated, m)
}

func main() {
	initDB()
	defer db.Close()

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())
	r.Use(rateLimitMiddleware())

	r.GET("/health", healthHandler)

	api := r.Group("/api/v1")
	{
		api.GET("/users", listUsers)
		api.POST("/users", adminKeyMiddleware(), createUser)
		api.GET("/ip/me", lookupSelf)
		api.GET("/ip/:ip", lookupIP)
		api.GET("/markers", listMarkers)
		api.GET("/markers/stream", subscribeSSE)
		api.POST("/markers", createMarker)
		api.DELETE("/markers/:id", adminKeyMiddleware(), deleteMarker)
		api.GET("/links/check", checkSlug)
		api.POST("/links", createLink)
		api.GET("/links", adminKeyMiddleware(), listLinks)
		api.DELETE("/links/:token", adminKeyMiddleware(), deleteLink)
		api.GET("/link/:prefix/:slug", getLinkInfo)
		api.POST("/link/:prefix/:slug", trackVisitor)
	}

	log.Println("Starting server on :5002")
	if err := r.Run(":5002"); err != nil {
		log.Fatal(err)
	}
}
