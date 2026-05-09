# Build stage
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Copy csproj and restore
COPY Sendie.Server.csproj .
RUN dotnet restore

# Copy everything else and build
COPY . .
RUN dotnet publish -c Release -o /app/publish

# Runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app

# Create non-root user and pre-create the data dirs that Data Protection /
# AllowListService write into. data/keys is locked down to the appuser.
RUN adduser --disabled-password --gecos '' --uid 1001 appuser \
 && mkdir -p /app/data/keys \
 && chown -R appuser:appuser /app \
 && chmod 700 /app/data/keys
USER appuser

# Copy published output owned by the runtime user
COPY --from=build --chown=appuser:appuser /app/publish .

# Expose port
EXPOSE 8080

# Set environment variables
ENV ASPNETCORE_URLS=http://+:8080
ENV ASPNETCORE_ENVIRONMENT=Production

ENTRYPOINT ["dotnet", "Sendie.Server.dll"]
