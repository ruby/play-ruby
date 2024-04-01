# This file is responsible for running GitHub OAuth service.
# This service does not store any user data or access tokens.

require 'sinatra'
require 'sinatra/reloader'
require 'net/http'
require 'octokit'

%w[
  GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET
  PLAY_RUBY_FRONTEND_URL PLAY_RUBY_SERVER_URL
].each do |env|
  raise "#{env} is required" unless ENV[env]
  Object.const_set(env, ENV[env])
end

use Rack::Session::Cookie, {
  same_site: :none,
  coder: Rack::Session::Cookie::Base64::JSON.new,
  secure: true,
  partitioned: true,
  assume_ssl: true,
}

before do
  current_origin = request.env['HTTP_ORIGIN']
  headers 'Access-Control-Allow-Origin' => PLAY_RUBY_FRONTEND_URL
  headers 'Access-Control-Allow-Credentials' => 'true'
end

options '*' do
  response.headers['Allow'] = 'HEAD,GET,PUT,POST,DELETE,OPTIONS'
  response.headers['Access-Control-Allow-Headers'] = 'X-Requested-With, X-HTTP-Method-Override, Content-Type, Cache-Control, Accept'
  200
end

def authenticated?
  session[:access_token]
end

def authenticate!
  redirect_uri = URI.parse(PLAY_RUBY_FRONTEND_URL)
  redirect_uri.path = '/callback.html'
  redirect_query = { server_url: PLAY_RUBY_SERVER_URL }
  if params[:origin]
    redirect_query[:origin] = params[:origin]
  end
  redirect_uri.query = URI.encode_www_form(redirect_query)

  authorize_uri = URI.parse "https://github.com/login/oauth/authorize"
  authorize_uri.query = URI.encode_www_form({
    scope: "public_repo",
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: redirect_uri.to_s
  })
  redirect authorize_uri.to_s
end

module GitHubExtras
  module_function
  def get_branch_latest_run_id(client, repo:, branch:, workflow_path:)
    self.commits(client, repo, branch) do |commit|
      runs_url = "https://api.github.com/repos/#{repo}/actions/runs?event=push&branch=#{branch}&commit_sha=#{commit['sha']}&status=success&exclude_pull_requests=true"
      runs = client.get(runs_url)
      runs['workflow_runs'].each do |run|
        if run['path'] == workflow_path
          return run['id']
        end
      end
    end
    raise "Run not found: #{workflow_path}"
  end

  def get_pull_request_latest_run_id(client, repo:, pr_number:, workflow_path:)
    pr = client.pull_request(repo, pr_number)
    head_sha = pr['head']['sha']
    runs_url = "https://api.github.com/repos/#{repo}/actions/runs?event=pull_request&status=success&pull_requests=#{pr_number}"
    runs = client.get(runs_url)
    runs['workflow_runs'].each do |run|
      if run['head_sha'] == head_sha && run['path'] == workflow_path
        return run['id']
      end
    end
    raise "Run not found: #{workflow_path}"
  end

  def commits(client, repo, branch)
    commits = client.commits(repo, branch)
    last_response = client.last_response
    while last_response.rels[:next]
      commits.each do |commit|
        puts "Checking commit #{commit['sha']}"
        yield commit
      end
      page += 1
      commits = last_response.rels[:next].get
      last_response = client.last_response
    end
  end
end

def download_info_from_run_id(client, repo, workflow_path, run_id)
  artifact_name = "ruby-wasm-install"

  run_url = "https://api.github.com/repos/#{repo}/actions/runs/#{run_id}"
  run = client.get(run_url)
  artifacts = client.get(run['artifacts_url'])
  artifact = artifacts['artifacts'].find { |artifact| artifact['name'] == artifact_name }
  raise "Artifact not found" unless artifact

  # Resolve the final download URL which does not require authentication
  archive_download_url = artifact['archive_download_url']
  result = Net::HTTP.get_response(URI(archive_download_url), {
    'Accept' => 'application/json',
    'Authorization' => "bearer #{client.access_token}"
  })
  artifact['archive_download_url'] = result['location']

  {
    run: {
      id: run['id'],
      html_url: run['html_url'],
      head_commit: run['head_commit'].to_h
    },
    artifact: artifact.to_h
  }.to_json
end

get '/download_info' do
  access_token = session[:access_token]
  return 401 unless access_token

  payload = params[:payload] or raise "?payload= parameter is required"
  repo = "ruby/ruby"
  workflow_path = ".github/workflows/wasm.yml"

  case params[:source]
  when "run"
    run_id = payload
  when "pr"
    pr_number = payload
    run_id = GitHubExtras.get_pull_request_latest_run_id(client, repo: repo, pr_number: pr_number, workflow_path: workflow_path)
  else
    raise "?source= parameter is missing or invalid"
  end

  client = Octokit::Client.new(access_token: access_token)
  if run_id == "latest"
    run_id = GitHubExtras.get_branch_latest_run_id(client, repo: repo, branch: "master", workflow_path: workflow_path)
  end

  content_type :json
  return download_info_from_run_id(client, repo, workflow_path, run_id)
end

get '/sign_in' do
  if !authenticated?
    authenticate!
  else
    access_token = session[:access_token]
    scopes = []

    begin
      auth_result = Net::HTTP.get(URI('https://api.github.com/user'), {
        'Accept' => 'application/json',
        'Authorization' => "bearer #{access_token}"
      })
    rescue => e
      session[:access_token] = nil
      return authenticate!
    end
  end
end

get '/sign_out' do
  session[:access_token] = nil
  :ok
end

get '/callback' do
  session_code = request.env['rack.request.query_hash']['code']

  request = Net::HTTP::Post.new(
    URI('https://github.com/login/oauth/access_token'),
    {
      'Content-Type' => 'application/x-www-form-urlencoded',
      'Accept' => 'application/json'
    }
  )
  request.form_data = {
    'client_id' => GITHUB_CLIENT_ID,
    'client_secret' => GITHUB_CLIENT_SECRET,
    'code' => session_code
  }
  result = Net::HTTP.start(request.uri.hostname, request.uri.port, use_ssl: true) do |http|
    http.request(request)
  end
  unless result.code.to_i == 200
    return "Error getting access token: #{result.body}"
  end

  unless access_token = JSON.parse(result.body)['access_token']
    return "Error getting access token: #{result.body}"
  end
  session[:access_token] = access_token

  :ok
end
