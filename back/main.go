package main

import (
	"context"
	"log"
	"net/http"
	"os"
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
				return
			}
		}
		log.Printf("DB not ready, retrying in 2s... (%d/10)", i+1)
		time.Sleep(2 * time.Second)
	}
	log.Fatal("Could not connect to database:", err)
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
	err := db.QueryRow(
		context.Background(),
		"INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
		body.Name, body.Email,
	).Scan(&id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": id, "name": body.Name, "email": body.Email})
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
	}

	log.Println("Starting server on :5002")
	if err := r.Run(":5002"); err != nil {
		log.Fatal(err)
	}
}
