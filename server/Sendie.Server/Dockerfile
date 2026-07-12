# Build stage
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Copy csproj and restore
COPY Sendie.Server.csproj .
RUN dotnet restore

# Copy everything else and build
COPY . .
RUN dotnet publish -c Release -o /app/publish

# Runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app

# Use the non-root app identity built into Microsoft .NET images. Pre-create
# the data dirs that Data Protection / AllowListService write into.
RUN mkdir -p /app/data/keys \
 && chown -R app:app /app \
 && chmod 700 /app/data/keys
USER $APP_UID

# Copy published output owned by the runtime user
COPY --from=build --chown=app:app /app/publish .

# Expose port
EXPOSE 8080

# Set environment variables
ENV ASPNETCORE_URLS=http://+:8080
ENV ASPNETCORE_ENVIRONMENT=Production

ENTRYPOINT ["dotnet", "Sendie.Server.dll"]
