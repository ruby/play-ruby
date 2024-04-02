# frozen_string_literal: true

source "https://rubygems.org"

ruby "3.3.0"

gem "sinatra"

gem "rackup", "~> 2.1"

gem "sinatra-contrib", "~> 4.0"
# Use pre-released version for "Partitioned" cookie support:
# https://github.com/rack/rack/commit/958ed518cda851546c4d26ff9fd4db6255bd4021
gem "rack", github: "rack/rack", ref: "8c73aefcc7085c71bdfe6c1ec867f126ede34124"
# Use pre-released version for "assume_ssl" option to make "secure" option work in development:
# https://github.com/rack/rack-session/commit/219d8da15b0d1a02c650f956df29db42408a6adb
gem "rack-session", github: "rack/rack-session", ref: "219d8da15b0d1a02c650f956df29db42408a6adb"

gem "octokit", "~> 8.1"

gem "debug", "~> 1.9"
